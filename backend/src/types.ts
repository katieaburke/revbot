// Mirror of Prisma enums — defined here so code compiles before first DB migration
// These must stay in sync with prisma/schema.prisma

export enum AlertType {
  PAST_DUE_INITIAL = 'PAST_DUE_INITIAL',
  PAST_DUE_AMENDMENT = 'PAST_DUE_AMENDMENT',
  PAST_DUE_RENEWAL = 'PAST_DUE_RENEWAL',
  STALLED = 'STALLED',
  MEDDPICC_MISSING = 'MEDDPICC_MISSING',
}

export enum NotificationStatus {
  SENT = 'SENT',
  SNOOZED = 'SNOOZED',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
  FAILED = 'FAILED',
}
