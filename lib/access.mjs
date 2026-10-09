// Who may reach the dashboard. It starts and stops processes and opens files, so
// the default is this machine only; anything wider is named by the person who
// starts it, on the command line or in the environment — never through the API,
// where a client could grant itself access.

const LOOPBACK = ['127.0.0.0/8', '::1'];

/**
 * Turns a dotted IPv4 address into a number.
 * @param text - the address
 * @returns the 32-bit value, or null when it is not IPv4
 */
function ipv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/**
 * Normalises what the socket reports: Node shows an IPv4 client on a dual-stack
 * listener as "::ffff:a.b.c.d", which would otherwise never match a plain rule.
 * @param address - request.socket.remoteAddress
 * @returns the address without the IPv4-mapped prefix
 */
function normalise(address) {
  return String(address ?? '').replace(/^::ffff:/i, '').toLowerCase();
}

/**
 * Parses one allow rule: an address, an IPv4 range like 192.168.1.0/24, or
 * 0.0.0.0 meaning anyone.
 * @param rule - the text of the rule
 * @returns a function that tests an address, or null when the rule is not valid
 */
function parseRule(rule) {
  const text = rule.trim().toLowerCase();
  if (text === '') return null;
  if (text === '0.0.0.0' || text === '0.0.0.0/0' || text === '*') return () => true;
  const [base, bits] = text.split('/');
  const network = ipv4(base);
  if (network !== null) {
    const length = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(length) || length < 0 || length > 32) return null;
    const size = 2 ** (32 - length);
    const start = Math.floor(network / size) * size;
    return (address) => {
      const value = ipv4(address);
      return value !== null && value >= start && value < start + size;
    };
  }
  // IPv6 is matched exactly; ranges for it are not worth the code here.
  if (bits === undefined && base.includes(':')) return (address) => address === base;
  return null;
}

/**
 * Builds the access policy.
 * @param list - comma-separated rules, or an array of them; loopback is always allowed
 * @returns `allows(address)`, `open` (anyone), `remote` (anything beyond this machine) and `invalid` rules
 */
export function accessPolicy(list) {
  const rules = (Array.isArray(list) ? list : String(list ?? '').split(',')).map((rule) => rule.trim()).filter(Boolean);
  const tests = [];
  const invalid = [];
  let open = false;
  for (const rule of [...LOOPBACK, ...rules]) {
    const test = parseRule(rule);
    if (test === null) invalid.push(rule);
    else tests.push(test);
    if (/^(0\.0\.0\.0(\/0)?|\\*)$/.test(rule.trim())) open = true;
  }
  return {
    allows: (address) => tests.some((test) => test(normalise(address))),
    open,
    remote: rules.length > 0,
    invalid,
  };
}
