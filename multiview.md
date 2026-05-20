WebGPU Multiview Rendering
Overview
Multiview rendering draws to multiple texture array layers in a single render pass. Instead of issuing one render pass per eye (2 draw calls), you issue one render pass that the GPU automatically broadcasts to both layers. The shader uses @builtin(view_index) to select per-eye data (like camera matrices).

Requirements
Device feature: Request 'chromium-experimental-multiview' when creating the device
Texture array: Color and depth attachments must be 2D texture arrays with arrayLayerCount matching viewCount
Separate shaders/pipelines: Multiview shaders use @builtin(view_index) and enable chromium_experimental_multiview. Non-multiview rendering (e.g., canvas preview) needs a separate shader/pipeline without these.
Uniform layout: Camera matrices for all views must be packed contiguously in a single uniform buffer, indexed by view_index in the shader
Step 1: Request multiview feature
const adapter = await navigator.gpu.requestAdapter({ xrCompatible: true });
const device = await adapter.requestDevice({
  requiredFeatures: ['chromium-experimental-multiview'],
});

Step 2: Write the multiview shader
The vertex shader receives @builtin(view_index) as an input parameter. This is a u32 provided by the GPU — it's 0 for the left eye and 1 for the right eye. Use it to index into a camera array:

enable chromium_experimental_multiview;

struct Camera {
  projection: mat4x4f,
  view: mat4x4f,
}
@group(0) @binding(0) var<uniform> cameras: array<Camera, 2>;

@vertex
fn vertexMain(
  @builtin(vertex_index) vi: u32,
  @builtin(view_index) view: u32
) -> @builtin(position) vec4f {
  // Use cameras[view] to get the correct eye's matrices
  return cameras[view].projection * cameras[view].view * position;
}

view_index is also available in the fragment shader if needed:

@fragment
fn fragmentMain(@builtin(view_index) view: u32) -> @location(0) vec4f {
  // Different tint per eye, for debugging
  if (view == 0u) { return vec4f(1,0,0,1); }
  else { return vec4f(0,1,0,1); }
}

Step 3: Create the pipeline
Create the pipeline normally. Dawn automatically detects that the shader uses view_index and creates the Vulkan pipeline with multiview support:

const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: multiviewModule, entryPoint: 'vertexMain' },
  fragment: { module: multiviewModule, entryPoint: 'fragmentMain',
    targets: [{ format: colorFormat }]
  },
  depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
});

Step 4: Set up uniform buffer
Pack both cameras contiguously. Each Camera struct is 128 bytes (2 x mat4x4f). The WGSL array<Camera, 2> places cameras[0] at byte 0 and cameras[1] at byte 128:

const FLOATS_PER_VIEW = 32; // 128 bytes / 4 bytes per float
const uniformArray = new Float32Array(FLOATS_PER_VIEW * 2);

// Per frame, write both eye matrices:
for (let i = 0; i < pose.views.length; i++) {
  const offset = FLOATS_PER_VIEW * i;
  uniformArray.set(pose.views[i].projectionMatrix, offset);
  uniformArray.set(pose.views[i].transform.inverse.matrix, offset + 16);
}
device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

Step 5: Create texture array views
The XR sub-images provide 2-layer texture arrays. Create '2d-array' views over both layers:

const subImage0 = xrGpuBinding.getViewSubImage(projectionLayer, pose.views[0]);
const subImage1 = xrGpuBinding.getViewSubImage(projectionLayer, pose.views[1]);

const colorArrayView = subImage0.colorTexture.createView({
  dimension: '2d-array',
  baseArrayLayer: 0,
  arrayLayerCount: 2,
});
const depthArrayView = subImage0.depthStencilTexture.createView({
  dimension: '2d-array',
  baseArrayLayer: 0,
  arrayLayerCount: 2,
});

Step 6: Begin multiview render pass
Pass viewCount: 2 in the render pass descriptor. This tells Dawn to create a Vulkan multiview render pass that broadcasts all draw calls to both layers:

const renderPass = commandEncoder.beginRenderPass({
  colorAttachments: [{
    view: colorArrayView,   // 2-layer array view
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: [0, 0, 0, 1],
  }],
  depthStencilAttachment: {
    view: depthArrayView,   // 2-layer array view
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
    depthClearValue: 1.0,
  },
  viewCount: 2,             // Enable multiview with 2 views
});

Step 7: Draw once
A single draw call renders to both eyes. The GPU invokes the vertex and fragment shaders for each view, providing the appropriate view_index:

renderPass.setPipeline(pipeline);
renderPass.setBindGroup(0, bindGroup);
renderPass.draw(vertexCount, instanceCount);
renderPass.end();
device.queue.submit([commandEncoder.finish()]);

Important notes
Canvas rendering needs a separate pipeline: A multiview pipeline (shader uses view_index) cannot be used with a non-multiview render pass (single-layer canvas). Create a separate shader/pipeline for canvas that doesn't use view_index.
view_index is GPU-provided: You don't pass it between shader stages. Both vertex and fragment shaders can declare @builtin(view_index) independently — the GPU provides the correct value to each stage.
Uniform buffer alignment: array<Camera, 2> in WGSL packs elements at 128-byte intervals (the size of the Camera struct). Make sure JS writes match this layout.
Both getViewSubImage calls are needed: Even though you create a single array view, calling getViewSubImage for both eyes tells the XR runtime that both views will be used.
