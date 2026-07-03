import Link from "next/link";
import { login } from "../actions";
import { Alert, Button, Card, Input, Label } from "@/components/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; msg?: string; next?: string }>;
}) {
  const { erro, msg, next } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-brand-700">Vitalis</h1>
          <p className="text-sm text-slate-500">
            Acompanhamento de pacientes
          </p>
        </div>

        {erro === "credenciais" && (
          <Alert kind="error">E-mail ou senha incorretos.</Alert>
        )}
        {msg === "confirme_email" && (
          <Alert kind="info">
            Conta criada! Confirme seu e-mail antes de entrar.
          </Alert>
        )}

        <Card>
          <form action={login} className="space-y-4">
            {next && <input type="hidden" name="next" value={next} />}
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
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <Button type="submit" className="w-full">
              Entrar
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-slate-500">
          Profissional de saúde sem conta?{" "}
          <Link
            href="/cadastro"
            className="font-medium text-brand-700 hover:underline"
          >
            Cadastre sua clínica
          </Link>
        </p>
      </div>
    </main>
  );
}
