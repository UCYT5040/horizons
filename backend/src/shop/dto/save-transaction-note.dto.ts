import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class SaveTransactionNoteDto {
  // Capped at 1000 to match the admin_note column width. Send an empty string
  // to clear the note.
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  content: string;
}
