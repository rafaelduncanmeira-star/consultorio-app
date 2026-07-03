"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createClinicAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/pro/onboarding?erro=nome");

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_clinic", { p_name: name });
  if (error) redirect("/pro/onboarding?erro=criar");

  redirect("/pro");
}

export async function createPatient(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("memberships")
    .select("clinic_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!membership) redirect("/pro/onboarding");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/pro/pacientes/novo?erro=nome");

  const { data, error } = await supabase
    .from("patients")
    .insert({
      clinic_id: membership.clinic_id,
      professional_id: user.id,
      name,
      phone: String(formData.get("phone") ?? "").trim() || null,
      email: String(formData.get("email") ?? "").trim() || null,
      birth_date: String(formData.get("birth_date") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (error || !data) redirect("/pro/pacientes/novo?erro=salvar");

  revalidatePath("/pro/pacientes");
  redirect(`/pro/pacientes/${data.id}`);
}

export async function updatePatient(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!id) redirect("/pro/pacientes");
  if (!name) redirect(`/pro/pacientes/${id}?erro=nome`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("patients")
    .update({
      name,
      phone: String(formData.get("phone") ?? "").trim() || null,
      email: String(formData.get("email") ?? "").trim() || null,
      birth_date: String(formData.get("birth_date") ?? "") || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    })
    .eq("id", id);

  if (error) redirect(`/pro/pacientes/${id}?erro=salvar`);

  revalidatePath(`/pro/pacientes/${id}`);
  redirect(`/pro/pacientes/${id}?msg=salvo`);
}

export async function createPatientInvite(formData: FormData) {
  const patientId = String(formData.get("patient_id") ?? "");
  if (!patientId) redirect("/pro/pacientes");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: patient } = await supabase
    .from("patients")
    .select("clinic_id")
    .eq("id", patientId)
    .single();
  if (!patient) redirect("/pro/pacientes");

  const { error } = await supabase.from("patient_invites").insert({
    clinic_id: patient.clinic_id,
    patient_id: patientId,
    created_by: user.id,
  });

  if (error) redirect(`/pro/pacientes/${patientId}?erro=convite`);

  revalidatePath(`/pro/pacientes/${patientId}`);
  redirect(`/pro/pacientes/${patientId}?msg=convite`);
}
