import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AirtableService } from './airtable.service';
import { PrismaService } from '../prisma.service';

/**
 * Hourly sweep of the Users table. The per-event hooks in
 * AirtableService.syncUserStats keep things fresh in normal flow, but stats
 * also drift via paths that don't trigger a sync (Hackatime recalc, manual
 * project edits). This cron walks every user with an Airtable record and
 * rewrites the four computed fields.
 *
 * Also hosts the hourly Transactions sweep: live hooks mirror each
 * transaction on create/fulfill/refund, and syncAllTransactions backfills
 * any row whose airtableRecId is still null.
 *
 * And the justification reverse-sync: the justification cell in the Approved
 * Projects table is edited by humans directly in Airtable. This cron makes the
 * sync bidirectional — it pulls those edits back into Horizons so the two sides
 * converge. (The forward-sync may later regenerate and overwrite on the next
 * admin edit; that's expected last-writer-wins behaviour.)
 */
@Injectable()
export class AirtableSyncService implements OnModuleInit {
  private readonly logger = new Logger(AirtableSyncService.name);

  // A drifted row is only pulled once its Horizons row has been quiet for this
  // long. Guards against reverting an in-flight/just-failed forward write
  // (where the DB is legitimately ahead of Airtable) before it can retry.
  private static readonly PULL_GRACE_MS = 10 * 60 * 1000;

  constructor(
    private airtableService: AirtableService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    // Fire-and-forget so startup isn't blocked by a full table sweep.
    this.runSync('startup').catch((err) =>
      this.logger.error('Startup Airtable user-stats sync threw:', err),
    );
    this.runTransactionSync('startup').catch((err) =>
      this.logger.error('Startup Airtable transaction sync threw:', err),
    );
    this.runJustificationReverseSync('startup').catch((err) =>
      this.logger.error('Startup Airtable justification reverse-sync threw:', err),
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlyUserStatsSync() {
    await this.runSync('hourly');
  }

  // Catch-up for transactions whose live sync failed (plus the one-time
  // backfill on first deploy). Cheap no-op query when nothing is pending, so
  // running every 10 minutes keeps Airtable from lagging behind.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleTransactionSync() {
    await this.runTransactionSync('interval');
  }

  // Pull human edits to the justification cell back into Horizons. Reads the
  // whole Approved Projects table (a handful of paged requests), so every 30
  // minutes keeps Airtable authoritative without hammering the API.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleJustificationReverseSync() {
    await this.runJustificationReverseSync('interval');
  }

  private async runSync(trigger: 'startup' | 'hourly') {
    this.logger.log(`Starting ${trigger} Airtable user-stats sync`);
    try {
      const result = await this.airtableService.syncAllUserStats();
      this.logger.log(
        `${trigger} Airtable user-stats sync complete: ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`,
      );
    } catch (err) {
      this.logger.error(`${trigger} Airtable user-stats sync threw:`, err);
    }
  }

  private async runTransactionSync(trigger: 'startup' | 'interval') {
    this.logger.log(`Starting ${trigger} Airtable transaction sync`);
    try {
      const result = await this.airtableService.syncAllTransactions();
      this.logger.log(
        `${trigger} Airtable transaction sync complete: ${result.created} created, ${result.failed} failed`,
      );
    } catch (err) {
      this.logger.error(`${trigger} Airtable transaction sync threw:`, err);
    }
  }

  /**
   * Airtable → Horizons for the justification cell. Horizons always writes the
   * DB and Airtable together, so a divergence between the two means the cell was
   * edited directly in Airtable. When that happens we pull Airtable's text into
   * Horizons so both sides converge, and record a system-actor audit entry.
   */
  private async runJustificationReverseSync(trigger: 'startup' | 'interval') {
    this.logger.log(`Starting ${trigger} Airtable justification reverse-sync`);
    let pulled = 0;
    let checked = 0;
    try {
      const airtableJustifications =
        await this.airtableService.fetchApprovedProjectJustifications();
      if (airtableJustifications.size === 0) {
        this.logger.log(
          `${trigger} justification reverse-sync: no Airtable records to reconcile`,
        );
        return;
      }

      // The Airtable cell mirrors Project.hoursJustification (the internal
      // reviewer justification), never Submission.hoursJustification, which is
      // the feedback shown to the submitter. Only the project's latest approved
      // submission still tracks the project value, so older approved rows are
      // left alone.
      const submissions = await this.prisma.submission.findMany({
        where: { approvalStatus: 'approved' },
        orderBy: { createdAt: 'desc' },
        select: {
          submissionId: true,
          projectId: true,
          airtableRecId: true,
          updatedAt: true,
          project: { select: { hoursJustification: true, updatedAt: true } },
        },
      });

      const graceCutoff = Date.now() - AirtableSyncService.PULL_GRACE_MS;
      const seenProjects = new Set<number>();

      for (const submission of submissions) {
        if (seenProjects.has(submission.projectId)) continue;
        seenProjects.add(submission.projectId);
        if (!submission.airtableRecId) continue;

        const airtableValue = airtableJustifications.get(
          submission.airtableRecId,
        );
        // No matching Airtable record (deleted, or never created) — nothing to
        // reconcile against.
        if (airtableValue === undefined) continue;
        checked++;

        if (
          AirtableService.normalizeJustification(airtableValue) ===
          AirtableService.normalizeJustification(
            submission.project.hoursJustification,
          )
        ) {
          continue;
        }

        // Row changed in Horizons very recently — could be an in-flight or
        // just-failed forward write rather than an Airtable edit. Let it retry
        // before we consider adopting Airtable's (possibly stale) value. The
        // pre-edit reconcile handles the "admin is editing right now" case
        // synchronously, so this window only defers passive drift.
        const lastWrite = Math.max(
          submission.updatedAt.getTime(),
          submission.project.updatedAt.getTime(),
        );
        if (lastWrite > graceCutoff) continue;

        await this.airtableService.applyJustificationPull({
          submissionId: submission.submissionId,
          projectId: submission.projectId,
          airtableRecId: submission.airtableRecId,
          from: submission.project.hoursJustification,
          to: airtableValue,
          trigger: 'cron',
        });
        pulled++;
      }

      this.logger.log(
        `${trigger} Airtable justification reverse-sync complete: ${pulled} pulled, ${checked} checked`,
      );
    } catch (err) {
      this.logger.error(
        `${trigger} Airtable justification reverse-sync threw:`,
        err,
      );
    }
  }
}
