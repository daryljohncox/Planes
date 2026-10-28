import handler from "../../api/aircraft.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
