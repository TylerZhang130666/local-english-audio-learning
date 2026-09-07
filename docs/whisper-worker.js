import { env, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = './models/';
env.useBrowserCache = true;

let transcriber = null;
let loadedDevice = '';

function send(type, payload) {
  self.postMessage(Object.assign({ type: type }, payload || {}));
}

self.onmessage = async function (event) {
  const message = event.data || {};
  try {
    if (message.type === 'load') {
      if (transcriber && loadedDevice === message.device) {
        send('ready', { device: loadedDevice });
        return;
      }
      loadedDevice = message.device;
      const options = {
        progress_callback: function (item) {
          send('model-progress', {
            status: item.status || '',
            file: item.file || '',
            progress: Number.isFinite(item.progress) ? item.progress : null
          });
        }
      };
      if (message.device === 'webgpu') {
        options.device = 'webgpu';
        options.dtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
      } else {
        options.device = 'wasm';
        options.dtype = 'q8';
      }
      transcriber = await pipeline(
        'automatic-speech-recognition',
        'onnx-community/whisper-tiny.en',
        options
      );
      send('ready', { device: loadedDevice });
      return;
    }

    if (message.type === 'transcribe') {
      if (!transcriber) throw new Error('模型尚未加载');
      const audio = new Float32Array(message.audio);
      const result = await transcriber(audio, {
        return_timestamps: true,
        language: 'en',
        task: 'transcribe',
        top_k: 0,
        do_sample: false
      });
      send('chunk-result', {
        requestId: message.requestId,
        text: result.text || '',
        chunks: Array.isArray(result.chunks) ? result.chunks : []
      });
    }
  } catch (error) {
    send('error', {
      requestId: message.requestId,
      message: error && error.message ? error.message : String(error)
    });
  }
};
