import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AirtableService } from '../airtable/airtable.service';
import { SlackService } from '../slack/slack.service';
import { LoopsService } from '../loops/loops.service';
import { TicketQualifyEmailService } from '../ticket-qualify-email/ticket-qualify-email.service';
import { ReviewSubmissionDto } from '../reviewer/dto/review-submission.dto';
import { AUDIT_ACTIONS } from './audit-actions';

function describeDetermination(
  newStatus: 'approved' | 'rejected',
  reviewPassed: boolean | null,
  fraudRaw: boolean | null,
  isSilent: boolean,
): string {
  if (newStatus === 'approved') {
    if (fraudRaw === null) return 'approved: fraud gate disabled, passed review';
    return 'approved: passed fraud and passed review';
  }
  if (isSilent) {
    if (reviewPassed === true) return 'rejected (silent): failed fraud, passed review';
    if (reviewPassed === false) return 'rejected (silent): failed both gates';
    return 'rejected (silent): failed fraud before review';
  }
  if (fraudRaw === true) return 'rejected: failed review, passed fraud';
  if (fraudRaw === null) return 'rejected: failed review, fraud gate disabled';
  return 'rejected: failed review';
}

/** Format decimal hours as "Xh Ymin". */
function formatHoursMin(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

interface FraudReviewInfo {
  joeProjectId: string;
  reviewedAt: Date;
  hackatimeProjects: string[];
  hackatimeUserId: string | null;
}

// Most recent prior APPROVED submission of the same project — presence means
// this record is an update to credit Airtable already carries.
interface PriorApprovedInfo {
  approvedHours: number | null;
  // Hours the previous reviewer took off by hand, on top of whatever the AI
  // reduction did. Carried forward so a reship doesn't silently re-credit time
  // an earlier reviewer already rejected — see priorManualReduction().
  manualReduction: number;
}

// AI time snapshot taken at review time, plus whether the reviewer left the
// automatic "credit AI time at 1/3" reduction switched on.
interface AiAdjustmentInfo {
  aiHours: number | null;
  reductionApplied: boolean | null;
}

// Share of tracked AI time that still counts toward approved hours.
const AI_CREDIT_FRACTION = 1 / 3;

/**
 * Approved hours the AI checkbox would produce on its own: non-AI time in full
 * plus a third of the AI time. Anything the approved figure differs from this
 * by is a manual adjustment the reviewer made on top.
 */
export function autoApprovedHours(
  trackedHours: number,
  aiHours: number,
): number {
  const ai = Math.min(Math.max(aiHours, 0), trackedHours);
  return trackedHours - ai + ai * AI_CREDIT_FRACTION;
}

/**
 * Hours a reviewer removed by hand on an already-approved submission: the gap
 * between what its settings computed automatically and what was actually
 * approved. Because approved hours are cumulative, this figure is itself
 * cumulative — a third ship inherits the sum of both earlier manual cuts
 * without any extra bookkeeping.
 *
 * Returns 0 when it can't be established (no tracked hours on record), and
 * never goes negative — a reviewer who granted *more* than the automatic figure
 * made a one-off allowance for that submission, not a standing credit.
 */
export function priorManualReduction(prior: {
  approvedHours: number | null;
  hackatimeHours: number | null;
  aiHours: number | null;
  aiReductionApplied: boolean | null;
}): number {
  if (prior.approvedHours == null || prior.hackatimeHours == null) return 0;
  const ai =
    prior.aiReductionApplied !== false && prior.aiHours != null
      ? Math.min(Math.max(prior.aiHours, 0), prior.hackatimeHours)
      : 0;
  const baseline = autoApprovedHours(prior.hackatimeHours, ai);
  return Math.max(0, baseline - prior.approvedHours);
}

/**
 * Origin the admin panel is served from. The gateway proxies /admin/* to the
 * admin UI on the same host as the user-facing app, so FRONTEND_URL is the base
 * for both. Mirrors the normalisation in reviewer.service.ts.
 */
function adminBaseUrl(): string {
  const frontendUrl =
    process.env.FRONTEND_URL || 'https://horizons.hackclub.com';
  return /^https?:\/\//.test(frontendUrl)
    ? frontendUrl
    : `https://${frontendUrl}`;
}

/**
 * The hours story: what Hackatime tracked, what the automatic AI reduction did
 * to it, and what the reviewer changed by hand on top of that.
 */
function buildHoursNarrative(
  hackatimeHours: number | null,
  approvedHours: number,
  ai?: AiAdjustmentInfo | null,
  priorApproved?: PriorApprovedInfo | null,
): string[] {
  const lines: string[] = [];
  const approved = formatHoursMin(approvedHours);
  const priorApprovedHours = priorApproved?.approvedHours ?? null;
  // Approved hours on a submission are the cumulative total for the project,
  // but only the delta is paid out to Airtable (see updateAirtableRecord), so
  // an update leads with all three figures — what this update adds, what was
  // already approved, and the running total — in place of the plain opener.
  // The delta is clamped at zero to match the payout, which never goes negative.
  if (priorApproved) {
    const deltaNote =
      priorApprovedHours != null
        ? `${formatHoursMin(Math.max(0, approvedHours - priorApprovedHours))} was approved in this update, and ${formatHoursMin(priorApprovedHours)} was already approved, for `
        : '';
    lines.push(
      `This is an update to a previously approved submission of this project — ${deltaNote}${approved} approved on this project in total.`,
    );
  } else {
    lines.push(`This project was approved for ${approved}.`);
  }

  if (hackatimeHours == null) {
    lines.push(
      `Hackatime tracked time for this project is unknown, so the hours were set by the reviewer.`,
    );
    return lines;
  }

  const tracked = formatHoursMin(hackatimeHours);
  const aiHours =
    ai?.aiHours != null && ai.aiHours > 0
      ? Math.min(ai.aiHours, hackatimeHours)
      : null;

  // What the reviewer's settings imply before any manual edit.
  let baseline: number;
  if (aiHours == null) {
    baseline = hackatimeHours;
    // These two read similarly but assert different things: a stored zero was
    // measured and found empty; a stored null means no AI snapshot exists at
    // all (pre-breakdown reviews, or Hackatime couldn't be reached).
    if (ai?.aiHours != null) {
      lines.push(
        `This user tracked ${tracked} on Hackatime for this project overall, and no AI coding time was detected.`,
      );
    } else {
      lines.push(
        `This user tracked ${tracked} on Hackatime for this project overall, with no AI coding time on record.`,
      );
    }
  } else {
    const nonAi = formatHoursMin(hackatimeHours - aiHours);
    const aiTracked = formatHoursMin(aiHours);
    if (ai?.reductionApplied === false) {
      baseline = hackatimeHours;
      lines.push(
        `This user tracked ${tracked} on Hackatime for this project overall. ${aiTracked} AI coding and ${nonAi} standard coding. The reviewer manually overrode the automatic 1/3 reduction of AI hours, so the AI time was credited in full, giving ${formatHoursMin(baseline)}.`,
      );
    } else {
      baseline = autoApprovedHours(hackatimeHours, aiHours);
      const aiReduced = formatHoursMin(aiHours * AI_CREDIT_FRACTION);
      lines.push(
        `This user tracked ${tracked} on Hackatime for this project overall. ${aiTracked} AI coding (reduced to 1/3 → ${aiReduced}) and ${nonAi} standard coding, giving ${formatHoursMin(baseline)}.`,
      );
    }
  }

  // A manual reduction on an earlier ship is a judgement about tracked time
  // that is still inside this ship's cumulative figure, so it carries forward.
  // Without this, a reship recomputes from the full tracked total and silently
  // re-credits hours a previous reviewer already rejected.
  const carriedReduction = priorApproved?.manualReduction ?? 0;
  if (carriedReduction >= 0.05) {
    baseline -= carriedReduction;
    lines.push(
      // Deliberately doesn't say "a reviewer" or name one approval: on a third
      // or later ship this figure is the sum of every earlier manual deduction,
      // possibly by different reviewers.
      `${formatHoursMin(carriedReduction)} has already been deducted by hand on previous approvals of this project. That time is still inside the tracked total above, so those deductions carry forward, giving ${formatHoursMin(baseline)}.`,
    );
  }

  // Approved hours are cumulative across reships, and Project.approvedHours
  // (the user's balance) is overwritten with this figure. A rising AI share on
  // an update can drag the computed total below what was already granted, which
  // would silently claw back credit for work that was already signed off — so
  // the baseline never falls below the previous approval.
  if (priorApprovedHours != null && baseline < priorApprovedHours - 0.05) {
    lines.push(
      `That is below the hours already approved for this project, so the hours were held at ${formatHoursMin(priorApprovedHours)} and nothing further was added by this update — an update never removes credit already granted.`,
    );
    baseline = priorApprovedHours;
  }

  if (Math.abs(baseline - approvedHours) >= 0.05) {
    lines.push(
      `The reviewer then manually adjusted the hours from ${formatHoursMin(baseline)} to ${approved}.`,
    );
  } else {
    lines.push('No further adjustment was made by the reviewer.');
  }
  return lines;
}

/**
 * Wrap the reviewer's analysis with boilerplate hours summary + fraud line + footer.
 */
function buildFullJustification(
  reviewerAnalysis: string,
  hackatimeHours: number | null,
  approvedHours: number,
  submitterSlackId: string | null,
  submissionDate: Date,
  reviewerSlackId: string | null,
  fraudReview?: FraudReviewInfo | null,
  priorApproved?: PriorApprovedInfo | null,
  aiAdjustment?: AiAdjustmentInfo | null,
  projectId?: number | null,
): string {
  const parts: string[] = [];

  parts.push(
    ...buildHoursNarrative(
      hackatimeHours,
      approvedHours,
      aiAdjustment,
      priorApproved,
    ),
  );

  if (reviewerAnalysis.trim()) {
    parts.push('', reviewerAnalysis.trim());
  }

  const submitterRef = submitterSlackId || 'unknown';
  const submitDate = submissionDate.toISOString().split('T')[0];
  const reviewerRef = reviewerSlackId || 'unknown';
  const today = new Date().toISOString().split('T')[0];

  parts.push('');
  parts.push(`Project was submitted by @/${submitterRef} on ${submitDate}.`);

  if (fraudReview) {
    const fraudDate = fraudReview.reviewedAt.toISOString().split('T')[0];
    const userSuffix = fraudReview.hackatimeUserId
      ? ` on Hackatime user #${fraudReview.hackatimeUserId}`
      : '';
    const projectsSuffix =
      fraudReview.hackatimeProjects.length > 0
        ? `, who reviewed the time tracked on ${fraudReview.hackatimeProjects.join(', ')}${userSuffix}`
        : '';
    parts.push(
      `Project passed fraud review (case ${fraudReview.joeProjectId}) from the Fraud Squad on ${fraudDate}${projectsSuffix}.`,
    );
  }

  parts.push(`Project was reviewed by @/${reviewerRef} on ${today}.`);

  // Links back into the admin panel so anyone auditing this record in Airtable
  // can jump straight to the project and to the review that produced it.
  if (projectId) {
    parts.push('');
    parts.push(`Project: ${adminBaseUrl()}/admin/projects/${projectId}`);
    parts.push(`Review: ${adminBaseUrl()}/admin/review/${projectId}`);
  }

  return parts.join('\n');
}

/**
 * Owns the reconciliation between the reviewer gate (Submission.reviewPassed) and
 * the fraud gate (Project.joeFraudPassed). Submission.approvalStatus stays `pending`
 * until both gates resolve, at which point this service transitions it to the final
 * outcome and fires all downstream side effects (Airtable sync, Slack, email via
 * Loops, project data copy).
 */
@Injectable()
export class SubmissionApprovalService {
  constructor(
    private prisma: PrismaService,
    private airtableService: AirtableService,
    private slackService: SlackService,
    private loopsService: LoopsService,
    private ticketQualifyEmailService: TicketQualifyEmailService,
  ) {}

  /**
   * Record the reviewer's decision and attempt to reconcile. If the fraud gate
   * hasn't produced a result yet, approvalStatus stays pending and nothing else
   * fires — the fraud poll will re-run this reconciliation when fraud resolves.
   */
  async recordReviewerDecision(
    submissionId: number,
    passed: boolean,
    reviewerId: number,
    dto: ReviewSubmissionDto,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      reviewPassed: passed,
      pendingSendEmail: dto.sendEmail === true,
      reviewedBy: reviewerId.toString(),
      reviewedAt: new Date(),
    };
    if (dto.hoursJustification !== undefined) {
      data.reviewerAnalysis = dto.hoursJustification;
    }
    await this.prisma.submission.update({
      where: { submissionId },
      data,
    });
    await this.evaluateAndFinalize(submissionId, reviewerId);
  }

  /**
   * Edit-in-place path for admins updating an already-finalized submission
   * (e.g., adjusting approvedHours on an already-approved submission).
   * Keeps the Airtable record in sync; does not re-run the state machine.
   */
  async updateFinalizedSubmission(
    submissionId: number,
    reviewerId: number,
    dto: ReviewSubmissionDto,
  ): Promise<void> {
    const submission = await this.prisma.submission.findUnique({
      where: { submissionId },
      include: {
        project: { include: { user: true } },
      },
    });
    if (!submission || submission.approvalStatus !== 'approved') return;

    // Rebuild the full justification if the reviewer edited it OR touched
    // anything the hours narrative reports on — the narrative quotes tracked,
    // AI and approved hours, so an hours-only edit would otherwise leave
    // Airtable asserting figures that no longer match the row. Reads the
    // hours back off the submission (already written by ReviewerService)
    // rather than the dto, so a partial edit still reads honestly.
    const hoursNarrativeChanged =
      dto.approvedHours !== undefined ||
      dto.aiHours !== undefined ||
      dto.aiReductionApplied !== undefined;
    let fullJustification: string | undefined;
    if (dto.hoursJustification !== undefined || hoursNarrativeChanged) {
      const reviewer = await this.prisma.user.findUnique({
        where: { userId: reviewerId },
        select: { slackUserId: true },
      });
      fullJustification = buildFullJustification(
        dto.hoursJustification ?? submission.reviewerAnalysis ?? '',
        submission.hackatimeHours,
        submission.approvedHours ?? 0,
        submission.project.user.slackUserId,
        submission.createdAt,
        reviewer?.slackUserId ?? null,
        this.buildFraudReviewInfo(submission.project),
        await this.getPriorApprovedInfo(submission),
        {
          aiHours: submission.aiHours,
          reductionApplied: submission.aiReductionApplied,
        },
        submission.projectId,
      );
    }

    const effective = {
      ...dto,
      ...(fullJustification ? { hoursJustification: fullJustification } : {}),
    };

    await this.syncProjectData(submission, effective);
    if (submission.airtableRecId) {
      await this.updateAirtableRecord(submission, effective);
    }
  }

  /**
   * Superadmin-only escape hatch: flip an already-finalized submission between
   * approved and rejected. Bypasses the two-gate state machine — caller is
   * responsible for role gating.
   *
   * Side effects:
   *  - Recomputes Project.approvedHours from the latest remaining approved
   *    submission (or null if none) so the user balance stays correct.
   *  - On →approved, updates the existing Airtable record if one exists, else
   *    creates a new one; on →rejected, leaves the per-project Airtable record
   *    in place (no delete endpoint) — surface the audit log entry to clean up.
   *  - Always re-syncs the user's Airtable stats so totals reflect the flip.
   *  - Sends notifications only when dto.sendEmail is true.
   */
  async applySuperadminOverride(
    submissionId: number,
    actorUserId: number,
    newStatus: 'approved' | 'rejected',
    dto: ReviewSubmissionDto,
  ): Promise<void> {
    const submission = await this.prisma.submission.findUnique({
      where: { submissionId },
      include: { project: { include: { user: true } } },
    });
    if (!submission) {
      throw new NotFoundException(`Submission ${submissionId} not found`);
    }
    const oldStatus = submission.approvalStatus;
    if (oldStatus === 'pending') {
      throw new BadRequestException(
        'Superadmin override only applies to finalized submissions; use the normal review flow for pending ones',
      );
    }
    if (oldStatus === newStatus) return;

    const finalizedAt = new Date();
    await this.prisma.submission.update({
      where: { submissionId },
      data: {
        approvalStatus: newStatus,
        reviewPassed: newStatus === 'approved',
        silentReject: false,
        reviewedBy: actorUserId.toString(),
        reviewedAt: finalizedAt,
        finalizedAt,
        pendingSendEmail: dto.sendEmail === true,
      },
    });
    submission.approvalStatus = newStatus;
    submission.reviewPassed = newStatus === 'approved';
    submission.silentReject = false;
    submission.finalizedAt = finalizedAt;
    submission.pendingSendEmail = dto.sendEmail === true;

    await this.prisma.submissionAuditLog.create({
      data: {
        submissionId,
        adminId: actorUserId,
        action: AUDIT_ACTIONS.superadminOverride,
        newStatus,
        approvedHours: submission.approvedHours ?? null,
        changes: {
          previousStatus: oldStatus,
          override: true,
        } as any,
      },
    });

    // Project.approvedHours is the source of truth for the user's balance
    // (BalanceService sums it across projects). Recompute from the latest
    // remaining approved submission so flipping this row doesn't strand stale
    // credit or hide newly-restored credit.
    const latestApproved = await this.prisma.submission.findFirst({
      where: { projectId: submission.projectId, approvalStatus: 'approved' },
      orderBy: { createdAt: 'desc' },
      select: { approvedHours: true },
    });
    await this.prisma.project.update({
      where: { projectId: submission.projectId },
      data: { approvedHours: latestApproved?.approvedHours ?? null },
    });

    let airtableDeleted = false;
    if (newStatus === 'approved') {
      const reviewerId = Number(submission.reviewedBy);
      const reviewer = Number.isFinite(reviewerId)
        ? await this.prisma.user.findUnique({
            where: { userId: reviewerId },
            select: { slackUserId: true },
          })
        : null;
      const fullJustification = buildFullJustification(
        submission.reviewerAnalysis ?? '',
        submission.hackatimeHours,
        submission.approvedHours ?? 0,
        submission.project.user.slackUserId,
        submission.createdAt,
        reviewer?.slackUserId ?? null,
        this.buildFraudReviewInfo(submission.project),
        await this.getPriorApprovedInfo(submission),
        {
          aiHours: submission.aiHours,
          reductionApplied: submission.aiReductionApplied,
        },
        submission.projectId,
      );
      if (submission.airtableRecId) {
        await this.updateAirtableRecord(submission, {
          approvedHours: submission.approvedHours ?? undefined,
          hoursJustification: fullJustification,
        });
      } else {
        await this.syncAirtable(submission, {
          approvedHours: submission.approvedHours ?? undefined,
          hoursJustification: fullJustification,
        });
      }
    } else if (
      newStatus === 'rejected' &&
      dto.deleteAirtableRecord &&
      submission.airtableRecId
    ) {
      // Failure here doesn't roll back the status flip — the flip already
      // updated balance, and a stuck Airtable row is recoverable manually,
      // while half-applied state would be more confusing.
      try {
        await this.airtableService.deleteApprovedProject(
          submission.airtableRecId,
        );
        await this.prisma.submission.update({
          where: { submissionId },
          data: { airtableRecId: null },
        });
        submission.airtableRecId = null;
        airtableDeleted = true;
      } catch (err) {
        console.error(
          '[SubmissionApproval] Airtable delete failed during override:',
          err,
        );
      }
    }

    if (airtableDeleted) {
      await this.prisma.submissionAuditLog.create({
        data: {
          submissionId,
          adminId: actorUserId,
          action: AUDIT_ACTIONS.superadminOverride,
          newStatus,
          approvedHours: submission.approvedHours ?? null,
          changes: { airtableDeleted: true } as any,
        },
      });
    }

    this.airtableService
      .syncUserStats(submission.project.user.email)
      .catch((err) =>
        console.error(
          '[SubmissionApproval] Airtable user-stats sync failed (override):',
          err,
        ),
      );

    await this.sendNotifications(submission, {
      approved: newStatus === 'approved',
      approvedHours: submission.approvedHours ?? undefined,
      feedback: submission.hoursJustification,
      sendEmail: dto.sendEmail === true,
      finalizedAt,
    });
  }

  /**
   * Called by the fraud poll after updating Project.joeFraudPassed. Fans out over
   * every pending submission on the project and re-runs reconciliation.
   */
  async onFraudStatusChanged(projectId: number): Promise<void> {
    const pending = await this.prisma.submission.findMany({
      where: { projectId, approvalStatus: 'pending' },
      select: { submissionId: true },
    });
    for (const s of pending) {
      await this.evaluateAndFinalize(s.submissionId, 0);
    }
  }

  private isFraudEnabled(): boolean {
    return !!(
      process.env.JOE_API_BASE_URL &&
      process.env.JOE_API_KEY &&
      process.env.JOE_EVENT_ID
    );
  }

  /**
   * Reconcile the two gates and transition approvalStatus from pending if possible.
   * CAS on approvalStatus='pending' makes this idempotent under reviewer + fraud-poll
   * races — exactly one caller wins the transition and fires side effects.
   *
   * Rule: fraud=false silent-rejects only when the reviewer has NOT explicitly
   * rejected. If the reviewer rejected, that decision is authoritative and the
   * user gets normal feedback (DM, in-app status, resubmit allowed). Pure
   * fraud-only rejections stay silent — the user sees "pending" and can't
   * resubmit, so fraud actors get no signal.
   *
   * Truth table:
   *   reviewPassed=null, fraud=null            → pending (both gates open)
   *   reviewPassed=null, fraud=true            → pending (awaiting reviewer)
   *   reviewPassed=null, fraud=false           → rejected, silent (fraud kicks out)
   *   reviewPassed=true, fraud=null            → pending (awaiting fraud)
   *   reviewPassed=true, fraud=true            → approved + full side effects
   *   reviewPassed=true, fraud=false           → rejected, silent
   *   reviewPassed=false, fraud=null           → rejected, normal (reviewer wins)
   *   reviewPassed=false, fraud=true           → rejected, normal
   *   reviewPassed=false, fraud=false          → rejected, normal (reviewer's call stands)
   */
  private async evaluateAndFinalize(
    submissionId: number,
    actorUserId: number,
  ): Promise<void> {
    const submission = await this.prisma.submission.findUnique({
      where: { submissionId },
      include: {
        project: { include: { user: true } },
      },
    });
    if (!submission || submission.approvalStatus !== 'pending') return;

    const reviewPassed = submission.reviewPassed;
    const fraudEnabled = this.isFraudEnabled();
    const fraudRaw = submission.project.joeFraudPassed;
    const fraudEffective = fraudEnabled ? fraudRaw : true;

    // Fraud failure rejects, but only silently if the reviewer hasn't also
    // rejected. A reviewer rejection is authoritative — the user deserves the
    // feedback even when fraud also fired.
    if (fraudEffective === false) {
      await this.commitTransition(
        submission,
        'rejected',
        reviewPassed !== false,
        actorUserId,
        fraudRaw,
      );
      return;
    }

    // Reviewer hasn't decided; wait.
    if (reviewPassed === null) return;

    // Reviewer approved but fraud hasn't returned; wait.
    if (reviewPassed === true && fraudEffective === null) return;

    if (reviewPassed === true && fraudEffective === true) {
      await this.commitTransition(
        submission,
        'approved',
        false,
        actorUserId,
        fraudRaw,
      );
      return;
    }

    // reviewPassed === false and fraud is not failed — normal rejection.
    await this.commitTransition(
      submission,
      'rejected',
      false,
      actorUserId,
      fraudRaw,
    );
  }

  private async commitTransition(
    submission: {
      submissionId: number;
      projectId: number;
      hackatimeHours: number | null;
      aiHours: number | null;
      aiReductionApplied: boolean | null;
      createdAt: Date;
      playableUrl: string | null;
      repoUrl: string | null;
      screenshotUrl: string | null;
      description: string | null;
      approvedHours: number | null;
      hoursJustification: string | null;
      reviewerAnalysis: string | null;
      reviewPassed: boolean | null;
      reviewedBy: string | null;
      pendingSendEmail: boolean;
      project: {
        projectTitle: string;
        projectId: number;
        playableUrl: string | null;
        repoUrl: string | null;
        screenshotUrl: string | null;
        description: string | null;
        joeProjectId: string | null;
        joeFraudPassed: boolean | null;
        joeFraudReviewedAt: Date | null;
        nowHackatimeProjects: string[];
        user: {
          email: string;
          slackUserId: string | null;
          hackatimeAccount: string | null;
        };
      };
    },
    newStatus: 'approved' | 'rejected',
    isSilent: boolean,
    actorUserId: number,
    fraudRaw: boolean | null,
  ): Promise<void> {
    // CAS: only the first caller wins the pending → terminal transition.
    const finalizedAt = new Date();
    const result = await this.prisma.submission.updateMany({
      where: { submissionId: submission.submissionId, approvalStatus: 'pending' },
      data: {
        approvalStatus: newStatus,
        silentReject: isSilent,
        finalizedAt,
      },
    });
    if (result.count === 0) return;

    await this.prisma.submissionAuditLog.create({
      data: {
        submissionId: submission.submissionId,
        adminId: actorUserId,
        action: AUDIT_ACTIONS.finalize,
        newStatus,
        approvedHours: submission.approvedHours ?? null,
        changes: {
          reviewPassed: submission.reviewPassed,
          joeFraudPassed: fraudRaw,
          silent: isSilent,
          determination: describeDetermination(
            newStatus,
            submission.reviewPassed,
            fraudRaw,
            isSilent,
          ),
        },
      },
    });

    if (newStatus === 'approved') {
      await this.fireApprovalSideEffects(submission, finalizedAt);
    } else if (!isSilent) {
      await this.fireRejectionSideEffects(submission, finalizedAt);
    }
  }

  private async fireApprovalSideEffects(
    submission: {
      submissionId: number;
      projectId: number;
      hackatimeHours: number | null;
      aiHours: number | null;
      aiReductionApplied: boolean | null;
      createdAt: Date;
      playableUrl: string | null;
      repoUrl: string | null;
      screenshotUrl: string | null;
      description: string | null;
      approvedHours: number | null;
      hoursJustification: string | null;
      reviewerAnalysis: string | null;
      reviewedBy: string | null;
      pendingSendEmail: boolean;
      project: {
        projectTitle: string;
        projectId: number;
        playableUrl: string | null;
        repoUrl: string | null;
        screenshotUrl: string | null;
        description: string | null;
        joeProjectId: string | null;
        joeFraudPassed: boolean | null;
        joeFraudReviewedAt: Date | null;
        nowHackatimeProjects: string[];
        user: {
          email: string;
          slackUserId: string | null;
          hackatimeAccount: string | null;
        };
      };
    },
    finalizedAt: Date,
  ): Promise<void> {
    // Rebuild the full justification from the persisted reviewer analysis +
    // current project / reviewer state. This defers to finalization time so
    // that fraud review info (populated after reviewer acted) is included.
    const reviewerId = Number(submission.reviewedBy);
    const reviewer = Number.isFinite(reviewerId)
      ? await this.prisma.user.findUnique({
          where: { userId: reviewerId },
          select: { slackUserId: true },
        })
      : null;
    const fullJustification = buildFullJustification(
      submission.reviewerAnalysis ?? '',
      submission.hackatimeHours,
      submission.approvedHours ?? 0,
      submission.project.user.slackUserId,
      submission.createdAt,
      reviewer?.slackUserId ?? null,
      this.buildFraudReviewInfo(submission.project),
      await this.getPriorApprovedInfo(submission),
      {
        aiHours: submission.aiHours,
        reductionApplied: submission.aiReductionApplied,
      },
      submission.projectId,
    );

    await this.syncProjectData(submission, {
      approvalStatus: 'approved',
      approvedHours: submission.approvedHours ?? undefined,
      hoursJustification: fullJustification,
    });
    await this.syncAirtable(submission, {
      approvedHours: submission.approvedHours ?? undefined,
      hoursJustification: fullJustification,
    });
    this.airtableService
      .syncUserStats(submission.project.user.email)
      .catch((err) =>
        console.error(
          '[SubmissionApproval] Airtable user-stats sync failed:',
          err,
        ),
      );
    // Run the ticket-qualify check first so we can suppress the
    // submission-approved email at the moment the user crosses the bar —
    // sending both would feel like spam. tryNotify is awaited (vs.
    // fire-and-forget) precisely to gate sendNotifications below.
    // Slack notifications still go out regardless.
    let qualifyEmailSent = false;
    try {
      qualifyEmailSent = await this.ticketQualifyEmailService.tryNotify(
        submission.project.user.email,
      );
    } catch (err) {
      console.error(
        '[SubmissionApproval] ticket-qualify email check failed:',
        err,
      );
    }

    await this.sendNotifications(submission, {
      approved: true,
      approvedHours: submission.approvedHours ?? undefined,
      feedback: submission.hoursJustification,
      sendEmail: submission.pendingSendEmail && !qualifyEmailSent,
      finalizedAt,
    });
  }

  private async fireRejectionSideEffects(
    submission: {
      submissionId: number;
      approvedHours: number | null;
      hoursJustification: string | null;
      pendingSendEmail: boolean;
      project: {
        projectTitle: string;
        projectId: number;
        user: { email: string };
      };
    },
    finalizedAt: Date,
  ): Promise<void> {
    this.airtableService
      .syncUserStats(submission.project.user.email)
      .catch((err) =>
        console.error(
          '[SubmissionApproval] Airtable user-stats sync failed:',
          err,
        ),
      );

    await this.sendNotifications(submission, {
      approved: false,
      approvedHours: submission.approvedHours ?? undefined,
      feedback: submission.hoursJustification,
      sendEmail: submission.pendingSendEmail,
      finalizedAt,
    });
  }

  /**
   * The most recent prior APPROVED submission of the same project, or null —
   * presence means this submission is an update whose Airtable record only
   * carries the additional hours. Rejected prior submissions don't count (a
   * reject → reship cycle reads as a first ship); prior approved credit
   * counts even with rejections in between. Mirrors the condition
   * syncAirtable uses to subtract previously approved hours.
   */
  private async getPriorApprovedInfo(submission: {
    submissionId: number;
    projectId: number;
    createdAt: Date;
  }): Promise<PriorApprovedInfo | null> {
    const lastApproved = await this.prisma.submission.findFirst({
      where: {
        projectId: submission.projectId,
        submissionId: { not: submission.submissionId },
        approvalStatus: 'approved',
        createdAt: { lt: submission.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        approvedHours: true,
        hackatimeHours: true,
        aiHours: true,
        aiReductionApplied: true,
      },
    });
    if (!lastApproved) return null;
    return {
      approvedHours: lastApproved.approvedHours,
      manualReduction: priorManualReduction(lastApproved),
    };
  }

  private buildFraudReviewInfo(project: {
    joeProjectId: string | null;
    joeFraudPassed: boolean | null;
    joeFraudReviewedAt: Date | null;
    nowHackatimeProjects: string[];
    user: { hackatimeAccount: string | null };
  }): FraudReviewInfo | null {
    if (!project.joeFraudPassed || !project.joeProjectId) return null;
    return {
      joeProjectId: project.joeProjectId,
      reviewedAt: project.joeFraudReviewedAt ?? new Date(),
      hackatimeProjects: project.nowHackatimeProjects,
      hackatimeUserId: project.user.hackatimeAccount,
    };
  }

  private async syncProjectData(
    submission: {
      projectId: number;
      playableUrl: string | null;
      repoUrl: string | null;
      screenshotUrl: string | null;
      description: string | null;
    },
    dto: {
      approvalStatus?: 'pending' | 'approved' | 'rejected';
      approvedHours?: number;
      hoursJustification?: string;
      adminComment?: string;
    },
  ): Promise<void> {
    const data: Record<string, unknown> = {};
    if (dto.approvedHours !== undefined) data.approvedHours = dto.approvedHours;
    if (dto.hoursJustification !== undefined)
      data.hoursJustification = dto.hoursJustification;
    if (dto.adminComment !== undefined) data.adminComment = dto.adminComment;
    if (dto.approvalStatus === 'approved') {
      data.playableUrl = submission.playableUrl;
      data.repoUrl = submission.repoUrl;
      data.screenshotUrl = submission.screenshotUrl;
      data.description = submission.description;
    }
    if (Object.keys(data).length === 0) return;
    await this.prisma.project.update({
      where: { projectId: submission.projectId },
      data,
    });
  }

  /** "First Last" for the Airtable "Reviewed By" cell; "User <id>" when the account is gone. */
  private async resolveReviewerName(
    reviewedBy: string | null,
  ): Promise<string | undefined> {
    if (!reviewedBy) return undefined;
    const reviewerId = Number(reviewedBy);
    if (!Number.isFinite(reviewerId)) return `User ${reviewedBy}`;
    const reviewer = await this.prisma.user.findUnique({
      where: { userId: reviewerId },
      select: { firstName: true, lastName: true },
    });
    return reviewer
      ? `${reviewer.firstName} ${reviewer.lastName}`
      : `User ${reviewedBy}`;
  }

  /** Create the Airtable record on first approval. Delta hours vs the prior approved submission. */
  private async syncAirtable(
    submission: {
      submissionId: number;
      projectId: number;
      createdAt: Date;
      playableUrl: string | null;
      repoUrl: string | null;
      screenshotUrl: string | null;
      description: string | null;
      reviewedBy: string | null;
      project: {
        playableUrl: string | null;
        repoUrl: string | null;
        screenshotUrl: string | null;
        description: string | null;
      };
    },
    dto: {
      approvedHours?: number;
      hoursJustification?: string;
    },
  ): Promise<void> {
    try {
      const project = await this.prisma.project.findUnique({
        where: { projectId: submission.projectId },
        include: {
          user: {
            include: { pinnedEvent: { include: { event: true } } },
          },
        },
      });
      if (!project) return;

      // The only subtraction here is prior Horizons credit on the same
      // project — the Airtable record for this submission should carry only
      // the NEW credit added by this submission.
      const totalApprovedHours = dto.approvedHours || 0;

      const lastApprovedSubmission = await this.prisma.submission.findFirst({
        where: {
          projectId: submission.projectId,
          approvalStatus: 'approved',
          createdAt: { lt: submission.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        select: { approvedHours: true },
      });
      const previouslyApprovedHours =
        lastApprovedSubmission?.approvedHours || 0;

      const deltaHours = Math.max(
        0,
        totalApprovedHours - previouslyApprovedHours,
      );

      const approvedProjectData = {
        user: {
          firstName: project.user.firstName,
          lastName: project.user.lastName,
          email: project.user.email,
          birthday: project.user.birthday,
          addressLine1: project.user.addressLine1,
          addressLine2: project.user.addressLine2,
          city: project.user.city,
          state: project.user.state,
          country: project.user.country,
          zipCode: project.user.zipCode,
        },
        project: {
          playableUrl:
            submission.playableUrl || submission.project.playableUrl || '',
          repoUrl: submission.repoUrl || submission.project.repoUrl || '',
          screenshotUrl:
            submission.screenshotUrl || submission.project.screenshotUrl || '',
          approvedHours: deltaHours,
          hoursJustification:
            project.hoursJustification || dto.hoursJustification || '',
          description:
            submission.description ||
            submission.project.description ||
            undefined,
          projectType: project.projectType,
          reviewedByName: await this.resolveReviewerName(submission.reviewedBy),
          eventSubmittedTo: project.user.pinnedEvent?.event?.slug ?? undefined,
        },
      };

      const airtableResult =
        await this.airtableService.createApprovedProject(approvedProjectData);
      if (airtableResult.recordId) {
        await this.prisma.submission.update({
          where: { submissionId: submission.submissionId },
          data: { airtableRecId: airtableResult.recordId },
        });
      }
    } catch (error) {
      console.error('Airtable sync failed:', error);
    }
  }

  /** Update an existing Airtable record when editing an already-approved submission. */
  private async updateAirtableRecord(
    submission: {
      submissionId: number;
      projectId: number;
      createdAt: Date;
      airtableRecId: string | null;
      playableUrl: string | null;
      repoUrl: string | null;
      screenshotUrl: string | null;
      description: string | null;
      reviewedBy: string | null;
      project: { projectType: string };
    },
    dto: { approvedHours?: number; hoursJustification?: string },
  ): Promise<void> {
    if (!submission.airtableRecId) return;
    try {
      let approvedHours = dto.approvedHours;

      if (approvedHours !== undefined) {
        const lastApprovedSubmission = await this.prisma.submission.findFirst({
          where: {
            projectId: submission.projectId,
            approvalStatus: 'approved',
            createdAt: { lt: submission.createdAt },
          },
          orderBy: { createdAt: 'desc' },
          select: { approvedHours: true },
        });
        const previouslyApprovedHours =
          lastApprovedSubmission?.approvedHours || 0;
        approvedHours = Math.max(0, approvedHours - previouslyApprovedHours);
      }

      await this.airtableService.updateApprovedProject(
        submission.airtableRecId,
        {
          playableUrl: submission.playableUrl || undefined,
          repoUrl: submission.repoUrl || undefined,
          screenshotUrl: submission.screenshotUrl || undefined,
          description: submission.description || undefined,
          approvedHours,
          hoursJustification: dto.hoursJustification,
          projectType: submission.project.projectType,
          reviewedByName: await this.resolveReviewerName(submission.reviewedBy),
        },
      );
    } catch (error) {
      console.error('Airtable update failed:', error);
    }
  }

  private async sendNotifications(
    submission: {
      submissionId: number;
      project: {
        projectTitle: string;
        projectId: number;
        user: { email: string };
      };
      hoursJustification: string | null;
    },
    payload: {
      approved: boolean;
      approvedHours?: number;
      feedback: string | null;
      sendEmail: boolean;
      finalizedAt: Date;
    },
  ): Promise<void> {
    if (payload.sendEmail) {
      // Email doesn't auto-resolve Slack mention syntax — replace `<@U…>`
      // with `@<displayName>` so users don't see raw mention IDs.
      const emailFeedback = await this.slackService.renderMentionsAsText(
        payload.feedback,
      );
      // Dedupe inside Loops' 24h window if this finalization is re-fired
      // outside the CAS (e.g. a manual admin retrigger on the same row).
      const idempotencyKey = `submission-review-${submission.submissionId}-${payload.finalizedAt.toISOString()}`;
      const result = await this.loopsService.sendSubmissionReviewEmail(
        submission.project.user.email,
        {
          projectTitle: submission.project.projectTitle,
          projectId: submission.project.projectId,
          approved: payload.approved,
          approvedHours: payload.approvedHours,
          feedback: emailFeedback ?? null,
        },
        { idempotencyKey },
      );
      if (!result.success) {
        console.error(
          `Loops email failed (status ${result.status}): ${result.message}`,
        );
      }
    }

    try {
      // Slack renders `<@U…>` natively, so pass feedback through unchanged.
      await this.slackService.notifySubmissionReview(
        submission.project.user.email,
        {
          projectTitle: submission.project.projectTitle,
          projectId: submission.project.projectId,
          approved: payload.approved,
          approvedHours: payload.approvedHours,
          feedback: payload.feedback ?? undefined,
        },
      );
    } catch (error) {
      console.error('Slack notification failed:', error);
    }
  }
}
