/**
 * Persistence of the Safe Mode decision.
 *
 * Reads must tolerate a missing or corrupt document by answering "off":
 * a config file we cannot parse must not be able to leave the user without
 * extensions forever, with no way to tell why.
 */
export interface SafeModeRecord {
  enabled: boolean;
  /** Why the user turned it on, shown in the banner. */
  reason?: string | null;
  /** When it was turned on, for diagnostics. */
  at?: number;
}

export interface SafeModeStore {
  read(): SafeModeRecord;
  write(record: SafeModeRecord): void;
}
