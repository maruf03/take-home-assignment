import { type PipeTransform } from '@nestjs/common';
import { ProblemError } from './problem.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2_147_483_647;

export class ParseUuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID_REGEX.test(value)) {
      throw new ProblemError('INVALID_ID', 'Identifier must be a UUID');
    }
    return value.toLowerCase();
  }
}

/** Version numbers are positive integers addressed under their document. */
export class ParseVersionNumberPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > PG_INT4_MAX) {
      throw new ProblemError('INVALID_ID', 'Version number must be a positive integer');
    }
    return Number(value);
  }
}
