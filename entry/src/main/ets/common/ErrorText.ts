// file: .ts - no UI here; this is the one place a failure becomes user-facing text
import { BusinessError } from '@kit.BasicServicesKit';

export function describeError(err: BusinessError): string {
  const message: string = err.message.length > 0 ? err.message : 'unknown error';
  // Only a Kit failure carries a numeric `code`; an Error our own code threw has none,
  // and printing `code undefined` at the user is worse than printing no code at all.
  const code: number = typeof err.code === 'number' ? err.code : 0;
  return code !== 0 ? `${message} (code ${code})` : message;
}
