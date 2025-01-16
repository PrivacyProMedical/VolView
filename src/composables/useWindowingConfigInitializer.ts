import { MaybeRef, computed, unref, watch, onMounted, onUnmounted } from 'vue';
import type { TypedArray } from '@kitware/vtk.js/types';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import { watchImmediate } from '@vueuse/core';
import { useImage } from '@/src/composables/useCurrentImage';
import { useWindowingConfig } from '@/src/composables/useWindowingConfig';
import { WLAutoRanges, WL_AUTO_DEFAULT, WL_HIST_BINS } from '@/src/constants';
import { getWindowLevels, useDICOMStore } from '@/src/store/datasets-dicom';
import useWindowingStore from '@/src/store/view-configs/windowing';
import useLoadDataStore from '@/src/store/load-data';

import { Maybe } from '@/src/types';
import { useResetViewsEvents } from '@/src/components/tools/ResetViews.vue';
import { isDicomImage } from '@/src/utils/dataSelection';

function useAutoRangeValues(imageID: MaybeRef<Maybe<string>>) {
  const { imageData } = useImage(imageID);

  const histogram = (
    data: number[] | TypedArray,
    dataRange: number[],
    numberOfBins: number
  ) => {
    const [min, max] = dataRange;
    const width = (max - min + 1) / numberOfBins;
    const hist = new Array(numberOfBins).fill(0);
    data.forEach((value) => hist[Math.floor((value - min) / width)]++);
    return hist;
  };

  const autoRangeValues = computed(() => {
    if (!imageData.value) {
      return {};
    }

    // Pre-compute the auto-range values
    const scalarData = imageData.value.getPointData().getScalars();
    // Assumes all data is one component
    const { min, max } = vtkDataArray.fastComputeRange(
      scalarData.getData() as number[],
      0,
      1
    );
    const hist = histogram(scalarData.getData(), [min, max], WL_HIST_BINS);
    const cumm = hist.reduce((acc, val, idx) => {
      const prev = idx !== 0 ? acc[idx - 1] : 0;
      acc.push(val + prev);
      return acc;
    }, []);

    const width = (max - min + 1) / WL_HIST_BINS;
    return Object.fromEntries(
      Object.entries(WLAutoRanges).map(([key, value]) => {
        const startIdx = cumm.findIndex(
          (v: number) => v >= value * 0.01 * scalarData.getData().length
        );
        const endIdx = cumm.findIndex(
          (v: number) => v >= (1 - value * 0.01) * scalarData.getData().length
        );
        const start = Math.max(min, min + width * startIdx);
        const end = Math.min(max, min + width * endIdx + width);
        return [key, [start, end]];
      })
    );
  });

  return { autoRangeValues };
}

export function useWindowingConfigInitializer(
  viewID: MaybeRef<string>,
  imageID: MaybeRef<Maybe<string>>
) {
  const { imageData } = useImage(imageID);
  const dicomStore = useDICOMStore();

  const loadDataStore = useLoadDataStore();

  const store = useWindowingStore();
  const { config: windowConfig } = useWindowingConfig(viewID, imageID);
  const { autoRangeValues } = useAutoRangeValues(imageID);
  const autoRange = computed<keyof typeof WLAutoRanges>(
    () => windowConfig.value?.auto || WL_AUTO_DEFAULT
  );

  const firstTag = computed(() => {
    const id = unref(imageID);
    if (id && isDicomImage(id)) {
      const volKey = id;
      const windowLevels = getWindowLevels(dicomStore.volumeInfo[volKey]);
      if (windowLevels.length) {
        return windowLevels[0];
      }
    }
    return undefined;
  });

  watchImmediate(windowConfig, (config) => {
    const image = imageData.value;
    const imageIdVal = unref(imageID);
    const viewIdVal = unref(viewID);
    if (config || !image || !imageIdVal) return;

    const [min, max] = image.getPointData().getScalars().getRange();
    store.updateConfig(viewIdVal, imageIdVal, { min, max });
    store.resetWindowLevel(viewIdVal, imageIdVal);
  });

  watchImmediate(imageData, (image) => {
    const imageIdVal = unref(imageID);
    const config = unref(windowConfig);
    const viewIdVal = unref(viewID);
    if (imageIdVal == null || config != null || !image) {
      return;
    }

    const [min, max] = autoRangeValues.value[autoRange.value];
    store.updateConfig(viewIdVal, imageIdVal, {
      min,
      max,
    });
    const firstTagVal = unref(firstTag);
    if (firstTagVal?.width) {
      store.updateConfig(viewIdVal, imageIdVal, {
        preset: {
          width: firstTagVal.width,
          level: firstTagVal.level,
        },
      });
    }
    const forcedWL = store.runtimeConfigWindowLevel;
    if (forcedWL) {
      store.updateConfig(viewIdVal, imageIdVal, {
        preset: {
          ...forcedWL,
        },
      });
    }
    store.resetWindowLevel(viewIdVal, imageIdVal);
  });

  watch(autoRange, (percentile) => {
    const image = imageData.value;
    const imageIdVal = unref(imageID);
    const viewIdVal = unref(viewID);
    if (imageIdVal == null || windowConfig.value == null || !image) {
      return;
    }
    const range = autoRangeValues.value[percentile];
    store.updateConfig(viewIdVal, imageIdVal, {
      min: range[0],
      max: range[1],
    });
    store.resetWindowLevel(viewIdVal, imageIdVal);
  });

  useResetViewsEvents().onClick(() => {
    const imageIdVal = unref(imageID);
    const viewIdVal = unref(viewID);
    if (imageIdVal == null || windowConfig.value == null) {
      return;
    }
    store.resetWindowLevel(viewIdVal, imageIdVal);
  });

  const useFirstTagVal = (payload: any) => {
    const dataID = payload.imageID;
    const volumeKeySuffix = loadDataStore.dataIDToVolumeKeyUID[dataID];
    const vol = loadDataStore.loadedByBus[volumeKeySuffix].volumes[dataID];
    if (vol && !vol.wlConfiged) {
      const viewIdVal = unref(viewID);
      if (viewIdVal && vol.layoutName?.includes(viewIdVal)) {
        const volInfo = dicomStore.volumeInfo[dataID];
        if (volInfo) {
          const windowLevels = getWindowLevels(volInfo);
          if (windowLevels[0]) {
            store.updateConfig(viewIdVal, dataID, {
              preset: {
                width: windowLevels[0].width,
                level: windowLevels[0].level,
              },
            });
            store.resetWindowLevel(viewIdVal, dataID);
            vol.wlConfiged = true;
          }
        }
      }
    }
  };
  onMounted(() => {
    // @ts-ignore
    (window.$bus.emitter || loadDataStore.$bus.emitter)?.on('gotimage', useFirstTagVal);
  });
  onUnmounted(() => {
    // @ts-ignore
    (window.$bus.emitter || loadDataStore.$bus.emitter)?.off('gotimage', useFirstTagVal);
  });
}
