"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function sanitizeNext(next: unknown): string | null {
  if (typeof next !== "string" || !next.startsWith("/")) return null;
  return next;
}

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNext(formData.get("next"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    const params = new URLSearchParams({ erro: "credenciais" });
    if (next) params.set("next", next);
    redirect(`/login?${params}`);
  }

  redirect(next ?? "/");
}

export async function signup(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const next = sanitizeNext(formData.get("next"));

  if (password.length < 8) {
    const params = new URLSearchParams({ erro: "senha_curta" });
    if (next) params.set("next", next);
    redirect(`/cadastro?${params}`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });

  if (error) {
    const params = new URLSearchParams({ erro: "cadastro" });
    if (next) params.set("next", next);
    redirect(`/cadastro?${params}`);
  }

  // Se a confirmação de e-mail estiver ligada no Supabase, não há sessão ainda.
  if (!data.session) {
    redirect(`/login?msg=confirme_email`);
  }

  redirect(next ?? "/");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
