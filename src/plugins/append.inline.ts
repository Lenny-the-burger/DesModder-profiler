import { compileGLesmos } from "#plugins/GLesmos/exportAsGLesmos.ts";
import { createShaderTagger } from "#plugins/shader-inspector/worker.ts";

(self as any).dsm_compileGLesmos = compileGLesmos as any;
(self as any).dsm_shader = createShaderTagger();

export default "";
