import { Alert, EmptyState } from "@/components/ui";

export default async function PacienteHojePage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;

  return (
    <div className="space-y-4">
      {msg === "bem_vindo" && (
        <Alert kind="success">
          Bem-vindo(a)! Sua conta está conectada à clínica. 🎉
        </Alert>
      )}
      <h1 className="text-lg font-bold text-slate-800">Hoje</h1>
      <EmptyState
        title="Nada por aqui ainda"
        description="Quando sua clínica prescrever seu plano de cuidado, os lembretes do dia aparecem aqui para você marcar como feitos."
      />
    </div>
  );
}
