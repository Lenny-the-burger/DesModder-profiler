import { compileGLesmos } from "#plugins/GLesmos/exportAsGLesmos.ts";
import { createWorkerProfiler } from "#plugins/profiler/worker.ts";
import { createShaderTagger } from "#plugins/shader-inspector/worker.ts";

(self as any).dsm_compileGLesmos = compileGLesmos as any;
(self as any).dsm_shader = createShaderTagger();

const profiler = createWorkerProfiler();
(self as any).dsm_profiler = profiler;
profiler.installWebGL((self as any).WebGL2RenderingContext?.prototype);
profiler.installMessageHook(self as any);

export default "";
