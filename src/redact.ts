export function redact(text: string): string {
  let output = text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g,
      '[REDACTED]',
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    );
  for (const name of Object.keys(process.env).filter((n) =>
    /(?:TOKEN|KEY|SECRET|PASSWORD)$/.test(n),
  )) {
    const value = process.env[name];
    if (value && value.length >= 8)
      output = output.replaceAll(value, '[REDACTED]');
  }
  return output;
}
