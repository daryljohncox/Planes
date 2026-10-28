import handler from "../../api/incidents.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
