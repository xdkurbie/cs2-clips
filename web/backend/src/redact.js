/** Strip credential query params so logs and errors cannot echo them. */
export function redact(value) {
  return String(value ?? "").replace(
    /\b(key|steamidkey|password|refreshToken|shared_secret|authCode|twoFactorCode)=([^&\s]+)/gi,
    "$1=[redacted]",
  );
}

export function clientError(res, status, code) {
  res.status(status).json({ error: code });
}
