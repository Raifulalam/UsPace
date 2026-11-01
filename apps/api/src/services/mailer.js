// STUB. Replace with a real provider (SES, Postmark, Resend...) before production.
// Never log verification tokens outside development.
async function sendVerificationEmail(email, token) {
  if (process.env.NODE_ENV === 'development') console.log(`[mailer:dev] verify ${email} -> token=${token}`);
}
async function sendPasswordResetEmail(email, token) {
  if (process.env.NODE_ENV === 'development') console.log(`[mailer:dev] password reset for ${email}: ${process.env.CLIENT_ORIGIN}/reset?token=${token}`);
}
module.exports = { sendVerificationEmail, sendPasswordResetEmail };
