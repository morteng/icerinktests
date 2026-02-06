// Fix for TS5.x + @webgpu/types: Float32Array<ArrayBufferLike> vs Float32Array<ArrayBuffer>
// The @webgpu/types package defines GPUAllowSharedBufferSource too strictly for TS5.x
// where Float32Array defaults to Float32Array<ArrayBufferLike>.
// See: https://github.com/gpuweb/types/issues/212
type GPUAllowSharedBufferSource =
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView;
