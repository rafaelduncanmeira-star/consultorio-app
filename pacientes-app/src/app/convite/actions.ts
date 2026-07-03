"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function acceptInvite(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!token) redirect("/login");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/convite/${token}`);

  const { error } = await supabase.rpc("accept_patient_invite", {
    p_token: token,
  });

  if (error) redirect(`/convite/${token}?erro=aceite`);

  redirect("/paciente?msg=bem_vindo");
}

export async function signupAndAccept(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!token) redirect("/login");

  if (password.length < 8) {
    redirect(`/convite/${token}?erro=senha_curta`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    // E-mail já cadastrado ou inválido → tenta pelo login
    redirect(`/convite/${token}?erro=cadastro`);
  }

  // Confirmação de e-mail ligada no Supabase: sem sessão ainda,
  // o aceite acontece quando o paciente entrar de novo pelo link.
  if (!data.session) {
    redirect(`/login?msg=confirme_email&next=/convite/${token}`);
  }

  const { error: rpcError } = await supabase.rpc("accept_patient_invite", {
    p_token: token,
  });
  if (rpcError) redirect(`/convite/${token}?erro=aceite`);

  redirect("/paciente?msg=bem_vindo");
}
