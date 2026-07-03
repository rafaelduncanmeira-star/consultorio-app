import { createClient } from "@/lib/supabase/server";
import type { Membership, Patient } from "@/lib/types";

export interface SessionContext {
  user: { id: string; email: string | null } | null;
  membership: (Membership & { clinic_name: string }) | null;
  patient: Patient | null;
}

/**
 * Resolve quem é o usuário logado nesta requisição:
 * - membro de clínica (visão pro),
 * - paciente vinculado (visão paciente),
 * - ou nenhum dos dois (precisa de onboarding/convite).
 */
export async function getSessionContext(): Promise<SessionContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, membership: null, patient: null };

  const [{ data: membershipRow }, { data: patientRows }] = await Promise.all([
    supabase
      .from("memberships")
      .select("clinic_id, user_id, role, created_at, clinics(name)")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("patients")
      .select("*")
      .eq("user_id", user.id)
      .limit(1),
  ]);

  const membership = membershipRow
    ? {
        clinic_id: membershipRow.clinic_id,
        user_id: membershipRow.user_id,
        role: membershipRow.role,
        created_at: membershipRow.created_at,
        clinic_name:
          (membershipRow.clinics as unknown as { name: string } | null)?.name ??
          "",
      }
    : null;

  return {
    user: { id: user.id, email: user.email ?? null },
    membership,
    patient: (patientRows?.[0] as Patient | undefined) ?? null,
  };
}
