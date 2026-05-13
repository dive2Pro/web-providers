export function logServiceStarted(serviceName: string, address: string) {
  const url = new URL(address);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  console.log(`[${serviceName}] listening on ${address} (port ${port})`);
}
