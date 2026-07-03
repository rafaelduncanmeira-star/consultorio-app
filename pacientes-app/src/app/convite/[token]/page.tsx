import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { acceptInvite, signupAndAccept } from "../actions";
import { Alert, Button, Card, Input, Label } from "@/components/ui";

interface PeekResult {
  valid: boolean;
  clinic_name?: string;
  patient_first_name?: string;
}

export default async function ConvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ erro?: string }>;
}) {
  const [{ token }, { erro }] = await Promise.all([params, searchParams]);

  const supabase = await createClient();
  const { data: peek } = await supabase.rpc("peek_patient_invite", {
    p_token: token,
  });
  const invite = (peek ?? { valid: false }) as PeekResult;

  const { user, patient, membership } = await getSessionContext();

  // Quem já é paciente vinculado não precisa aceitar de novo
  if (user && patient) redirect("/paciente");

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-brand-700">Vitalis</h1>
          <p className="text-sm text-slate-500">Convite de paciente</p>
        </div>

        {!invite.valid ? (
          <Card>
            <p className="text-sm text-slate-600">
              Este convite não é válido — pode ter expirado ou já ter sido
              usado. Peça um novo link para a sua clínica.
            </p>
          </Card>
        ) : (
          <>
            <Alert kind="info">
              Olá{invite.patient_first_name ? `, ${invite.patient_first_name}` : ""}!{" "}
              <strong>{invite.clinic_name}</strong> convidou você para
              acompanhar seu cuidado pelo app.
            </Alert>

            {erro === "senha_curta" && (
              <Alert kind="error">A senha precisa ter pelo menos 8 caracteres.</Alert>
            )}
            {erro === "cadastro" && (
              <Alert kind="error">
                Não foi possível criar a conta. Se você já tem cadastro,{" "}
                <Link
                  href={`/login?next=/convite/${token}`}
                  className="font-medium underline"
                >
                  entre por aqui
                </Link>
                .
              </Alert>
            )}
            {erro === "aceite" && (
              <Alert kind="error">
                Não foi possível ativar o convite. Tente novamente ou peça um
                novo link à clínica.
              </Alert>
            )}
            {membership && (
              <Alert kind="error">
                Esta conta faz parte da equipe da clínica e não pode ser usada
                como paciente. Saia e use outro e-mail.
              </Alert>
            )}

            {user && !membership && (
              <Card>
                <form action={acceptInvite} className="space-y-3">
                  <input type="hidden" name="token" value={token} />
                  <p className="text-sm text-slate-600">
                    Você está logado como <strong>{user.email}</strong>.
                  </p>
                  <Button type="submit" className="w-full">
                    Aceitar convite
                  </Button>
                </form>
              </Card>
            )}

            {!user && (
              <>
                <Card>
                  <form action={signupAndAccept} className="space-y-4">
                    <input type="hidden" name="token" value={token} />
                    <div>
                      <Label htmlFor="email">Seu e-mail</Label>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="password">
                        Crie uma senha (mín. 8 caracteres)
                      </Label>
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
                      Criar conta e entrar
                    </Button>
                  </form>
                </Card>
                <p className="text-center text-sm text-slate-500">
                  Já tem conta?{" "}
                  <Link
                    href={`/login?next=/convite/${token}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    Entrar
                  </Link>
                </p>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
