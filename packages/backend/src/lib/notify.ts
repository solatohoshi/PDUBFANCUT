import type { FastifyBaseLogger } from 'fastify'

interface NotifyDeps {
  log: FastifyBaseLogger
}

export async function sendClipsReadyEmail(
  { log }: NotifyDeps,
  projectId: string,
  projectName: string,
  userId: string | null | undefined,
): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY
  const clerkKey  = process.env.CLERK_SECRET_KEY
  if (!resendKey || !clerkKey || !userId) return

  try {
    const { createClerkClient } = await import('@clerk/backend')
    const clerk = createClerkClient({ secretKey: clerkKey })
    const user  = await clerk.users.getUser(userId)
    const email = user.emailAddresses[0]?.emailAddress
    if (!email) return

    const { Resend } = await import('resend')
    const resend  = new Resend(resendKey)
    const from    = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'
    const appUrl  = process.env.FRONTEND_URL ?? 'http://localhost:5173'
    const projUrl = `${appUrl}/projects/${projectId}`

    await resend.emails.send({
      from,
      to:      email,
      subject: `Your PWHL clips are ready — ${projectName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family:sans-serif;background:#0a0a18;color:#d0d0f0;margin:0;padding:32px">
          <div style="max-width:480px;margin:0 auto">
            <h1 style="color:#6c63ff;font-size:22px;margin-bottom:8px">
              PWHL Clip Studio
            </h1>
            <p style="font-size:16px;margin-bottom:24px">
              Your clips for <strong>${projectName}</strong> are ready to edit.
            </p>
            <a href="${projUrl}"
               style="display:inline-block;background:#6c63ff;color:#fff;
                      text-decoration:none;font-weight:700;font-size:14px;
                      padding:12px 24px;border-radius:8px">
              Open in editor →
            </a>
            <p style="font-size:12px;color:#505080;margin-top:32px">
              You're receiving this because you uploaded a file to PWHL Clip Studio.
            </p>
          </div>
        </body>
        </html>
      `,
    })

    log.info({ projectId, email }, 'Clips-ready email sent')
  } catch (err: any) {
    log.warn({ err: err.message, projectId }, 'Failed to send clips-ready email')
  }
}
