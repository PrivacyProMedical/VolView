import { inject, onMounted, onUnmounted } from 'vue';
import { useUrlSearchParams } from '@vueuse/core';

export function useEventBus(handlers, loadDataStore) {
  const query = useUrlSearchParams();
  const { uid, datasetId, projectId, pipelineId, manualNodeId } = query;

  const peerId = `volview-${projectId || datasetId || uid || window.btoa(document.location.href)}`;
  const ports = Object.create(null);

  const emitter = inject('bus');
  const bus = { emitter };

  const onload = handlers?.onload;
  const onunload = handlers?.onunload;
  const onunselect = handlers?.onunselect;
  let onsavesegmentation;
  let onslicing;
  let onclose;

  onMounted(async () => {
    if (handlers) {
      window.$bus = bus;
    } else {
      return;
    }

    if (onload) {
      emitter.on('load', onload);
    }
    if (onunload) {
      emitter.on('unload', onunload);
    }
    if (onunselect) {
      emitter.on('unselect', onunselect);
    }
    onsavesegmentation = payload => {
      if (pipelineId && manualNodeId) {
        const labelmap = payload?.data?.path;
        if (labelmap) {
          const msg = {
            type: 'created-segmentation',
            payload: {
              pipelineId,
              manualNodeId,
              oid: uid,
              labelmap,
            },
          };
          const port = ports[`comfyui-${pipelineId}`];
          if (port) {
            port.postMessage(msg);
          } else if (window.parent !== window) {
            window.parent.postMessage(msg, '*');
          }
        }
      }
    };
    onslicing = payload => {
      const port = ports[peerId.replace('volview-', 'tab-project-')];
      if (port) {
        port.postMessage({
          type: 'slicing',
          payload,
        });
      }
    };
    onclose = () => {
      const port = ports[peerId.replace('volview-', 'tab-project-')];
      if (port) {
        port.postMessage({
          type: 'close',
        });
      }
    };
    emitter.on('savesegmentation', onsavesegmentation);
    emitter.on('slicing', onslicing);
    emitter.on('close', onclose);

    if (loadDataStore) {
      loadDataStore.loadBus(bus.emitter);
      window.$loadDataStore = loadDataStore.$state;
    }

    if (window.parent !== window) {
      // window.addEventListener('message', e => // ...
      window.parent.postMessage('volview:LOAD', '*');
    } else {
      // window['__ports__'] = ports;
      window.addEventListener('message', (e) => {
        if (e.source === window && e.data?.type === 'response-message-port') {
          const { peer1, peer2 } = e.data.payload;
          if (peerId === peer1) {
            ports[peer2] = e.ports[0];
            const port = ports[peer2];
            port.onclose = () => {
              delete ports[peer2];
            };
            port.onmessage = (event) => {
              const { type, payload } = event.data;
              switch (type) {
                // ...
                default:
                  console.log(payload);
                  break;
              }
            };
          }
          if (peerId === peer2) {
            ports[peer1] = e.ports[0];
            const port = ports[peer1];
            port.onclose = () => {
              delete ports[peer1];
            };
            port.onmessage = (event) => {
              const { type, payload } = event.data;
              switch (type) {
                case 'load': {
                  window.$bus.emitter.emit(type, payload);
                  break;
                }
                case 'unload': {
                  window.$bus.emitter.emit(type);
                  break;
                }
                case 'unselect': {
                  window.$bus.emitter.emit(type);
                  break;
                }
                // ...
                default:
                  break;
              }
            };
          }
        }
      })
      while (!window.$electron) {
        // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
        await new Promise(r => setTimeout(r, 1000));
      }
      if (window.$electron && projectId) {
        window.$electron.requestMessagePort({
          peer1: peerId.replace('volview-', 'tab-project-'),
          peer2: peerId,
        });
      }
      console.log('[volview]', 'mounted!');
    }
  });

  onUnmounted(() => {
    if (!handlers) {
      return;
    }
    delete window.$bus;

    if (onload) {
      emitter.off('load', onload);
    }
    if (onunload) {
      emitter.off('unload', onunload);
    }
    if (onunselect) {
      emitter.off('unselect', onunselect);
    }
    if (onsavesegmentation) {
      emitter.off('savesegmentation', onsavesegmentation);
    }
    if (onslicing) {
      emitter.off('slicing', onslicing);
    }
    if (onclose) {
      emitter.off('close', onclose);
    }
  });

  return bus;
}
