import Link from "next/link";
import { signup } from "../actions";
import { Alert, Button, Card, Input, Label } from "@/components/ui";

export default async function CadastroPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; next?: string }>;
}) {
  const { erro, next } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-brand-700">Vitalis</h1>
          <p className="text-sm text-slate-500">Crie sua conta profissional</p>
        </div>

        {erro === "senha_curta" && (
          <Alert kind="error">A senha precisa ter pelo menos 8 caracteres.</Alert>
        )}
        {erro === "cadastro" && (
          <Alert kind="error">
            Não foi possível criar a conta. Verifique o e-mail e tente de novo.
          </Alert>
        )}

        <Card>
          <form action={signup} className="space-y-4">
            {next && <input type="hidden" name="next" value={next} />}
            <div>
              <Label htmlFor="name">Seu nome</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </div>
            <div>
              <Label htmlFor="password">Senha (mín. 8 caracteres)</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Criar conta
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-slate-500">
          Já tem conta?{" "}
          <Link
            href="/login"
            className="font-medium text-brand-700 hover:underline"
          >
            Entrar
          </Link>
        </p>
        <p className="text-center text-xs text-slate-400">
          Paciente? Use o link de convite enviado pela sua clínica.
        </p>
      </div>
    </main>
  );
}
