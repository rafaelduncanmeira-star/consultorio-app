import { EmptyState } from "@/components/ui";

export default function PacienteChatPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">Chat</h1>
      <EmptyState
        title="Chat em breve"
        description="Aqui você vai conversar direto com a equipe da sua clínica."
      />
    </div>
  );
}
