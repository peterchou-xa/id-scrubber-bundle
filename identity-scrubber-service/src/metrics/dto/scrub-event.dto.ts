export type PiiType =
  | 'name'
  | 'date_of_birth'
  | 'email'
  | 'phone_number'
  | 'address'
  | 'passport_number'
  | 'national_id'
  | 'credit_card'
  | 'bank_account'
  | 'ip_address'
  | 'other';

export interface ScrubEventDto {
  count: number;
  byType: Partial<Record<PiiType, number>>;
  clientId?: string;
  timestamp?: string;
}
