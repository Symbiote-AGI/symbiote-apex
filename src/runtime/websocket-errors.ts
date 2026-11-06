export function isUnhandledWsHandshakeTimeout(error: unknown): error is Error {
  if (!(error instanceof Error) || error.message !== 'Opening handshake has timed out') return false;
  return /(?:^|\n)\s*at .*[\\/]node_modules[\\/]ws[\\/]lib[\\/]websocket\.js:\d+:\d+/i.test(error.stack ?? '');
}
