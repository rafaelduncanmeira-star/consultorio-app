import { EmptyState } from "@/components/ui";

export default function PacienteConsultasPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">Consultas</h1>
      <EmptyState
        title="Nenhuma consulta marcada"
        description="Suas próximas consultas aparecerão aqui, com opção de confirmar presença."
      />
    </div>
  );
}
