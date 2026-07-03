import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";

export default async function Home() {
  const { user, membership, patient } = await getSessionContext();

  if (!user) redirect("/login");
  if (membership) redirect("/pro");
  if (patient) redirect("/paciente");

  // Logado mas sem clínica nem vínculo de paciente → onboarding
  redirect("/pro/onboarding");
}
