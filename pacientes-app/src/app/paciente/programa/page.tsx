import { EmptyState } from "@/components/ui";

export default function PacienteProgramaPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">Meu programa</h1>
      <EmptyState
        title="Você ainda não está em um programa"
        description="Quando sua clínica te inscrever em um programa de acompanhamento, o conteúdo e o seu progresso aparecem aqui."
      />
    </div>
  );
}
