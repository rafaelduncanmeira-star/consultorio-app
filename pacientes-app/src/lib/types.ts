// Tipos das linhas do banco (mantidos à mão até gerarmos via supabase gen types)

export type MembershipRole = "owner" | "professional" | "assistant";

export interface Clinic {
  id: string;
  name: string;
  created_at: string;
}

export interface Membership {
  clinic_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: string;
}

export interface Patient {
  id: string;
  clinic_id: string;
  professional_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  birth_date: string | null;
  notes: string | null;
  user_id: string | null;
  created_at: string;
}

export interface PatientInvite {
  token: string;
  clinic_id: string;
  patient_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}
