// STUB. Replace with a real provider (SES, Postmark, Resend...) before production.
// Never log verification tokens outside development.
async function sendVerificationEmail(email, token) {
  if (process.env.NODE_ENV === 'development') console.log(`[mailer:dev] verify ${email} -> token=${token}`);
}
module.exports = { sendVerificationEmail };
