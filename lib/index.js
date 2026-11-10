/**
 * Host half of the Traditional Chinese language pack.
 *
 * The Client half (`./client`) owns everything user-visible: it registers the
 * `zh-TW` language definition and every translated locale namespace with the
 * Client locale service. The Host half only carries the bundle row so the
 * plugin appears in the profile inventory and the Web GUI loads its Client
 * module.
 */
export function apply() {}
