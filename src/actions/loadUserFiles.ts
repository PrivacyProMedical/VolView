import { UrlParams } from '@vueuse/core';
import {
  fileToDataSource,
  uriToDataSource,
  DataSource,
  getDataSourceName,
} from '@/src/io/import/dataSource';
import type { LoadEventOptions } from '@/src/composables/useEventBus';
import useLoadDataStore from '@/src/store/load-data';
import { useDatasetStore } from '@/src/store/datasets';
import { useDICOMStore } from '@/src/store/datasets-dicom';
import { useLayersStore } from '@/src/store/datasets-layers';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { useViewStore } from '@/src/store/views';
import { getImageID } from '@/src/utils/dataSelection';
import { wrapInArray, nonNullable } from '@/src/utils';
import { basename } from '@/src/utils/path';
import { parseUrl } from '@/src/utils/url';
import { logError } from '@/src/utils/loggers';
import { PipelineResultSuccess, partitionResults } from '@/src/core/pipeline';
import {
  fetchSeries,
  fetchInstance,
} from '@/src/core/dicom-web-api';
import {
  ImportDataSourcesResult,
  importDataSources,
  toDataSelection,
} from '@/src/io/import/importDataSources';
import {
  ImportResult,
  LoadableResult,
  VolumeResult,
  isLoadableResult,
  isVolumeResult,
} from '@/src/io/import/common';

// higher value priority is preferred for picking a primary selection
const BASE_MODALITY_TYPES = {
  CT: { priority: 3 },
  MR: { priority: 3 },
  US: { priority: 2 },
  DX: { priority: 1 },
} as const;

function findBaseDicom(loadableDataSources: Array<LoadableResult>) {
  // find dicom dataset for primary selection if available
  const dicoms = loadableDataSources.filter(
    ({ dataType }) => dataType === 'dicom'
  );
  // prefer some modalities as base
  const dicomStore = useDICOMStore();
  const baseDicomVolumes = dicoms
    .map((dicomSource) => {
      const volumeInfo = dicomStore.volumeInfo[dicomSource.dataID];
      const modality = volumeInfo?.Modality as keyof typeof BASE_MODALITY_TYPES;
      if (modality in BASE_MODALITY_TYPES)
        return {
          dicomSource,
          priority: BASE_MODALITY_TYPES[modality]?.priority,
          volumeInfo,
        };
      return undefined;
    })
    .filter(nonNullable)
    .sort(
      (
        { priority: a, volumeInfo: infoA },
        { priority: b, volumeInfo: infoB }
      ) => {
        const priorityDiff = a - b;
        if (priorityDiff !== 0) return priorityDiff;
        // same modality, then more slices preferred
        if (!infoA.NumberOfSlices) return 1;
        if (!infoB.NumberOfSlices) return -1;
        return infoB.NumberOfSlices - infoA.NumberOfSlices;
      }
    );
  if (baseDicomVolumes.length) return baseDicomVolumes[0].dicomSource;
  return undefined;
}

function isSegmentation(extension: string, name: string) {
  if (!extension) return false; // avoid 'foo..bar' if extension is ''
  const extensions = name.split('.').slice(1);
  return extensions.includes(extension);
}

// does not pick segmentation images
function findBaseImage(
  loadableDataSources: Array<LoadableResult>,
  segmentGroupExtension: string
) {
  const baseImages = loadableDataSources
    .filter(({ dataType }) => dataType === 'image')
    .filter((importResult) => {
      const name = getDataSourceName(importResult.dataSource);
      if (!name) return false;
      return !isSegmentation(segmentGroupExtension, name);
    });

  if (baseImages.length) return baseImages[0];
  return undefined;
}

// returns image and dicom sources, no config files
function filterLoadableDataSources(
  succeeded: Array<PipelineResultSuccess<ImportResult>>
) {
  return succeeded.flatMap((result) => {
    return result.data.filter(isLoadableResult);
  });
}

// Returns list of dataSources with file names where the name has the extension argument
// and the start of the file name matches the primary file name.
function filterMatchingNames(
  primaryDataSource: VolumeResult,
  succeeded: Array<PipelineResultSuccess<ImportResult>>,
  extension: string
) {
  const primaryName = getDataSourceName(primaryDataSource.dataSource);
  if (!primaryName) return [];
  const primaryNamePrefix = primaryName.split('.').slice(0, 1).join();
  return filterLoadableDataSources(succeeded)
    .filter((ds) => ds !== primaryDataSource)
    .map((importResult) => ({
      importResult,
      name: getDataSourceName(importResult.dataSource),
    }))
    .filter(({ name }) => {
      if (!name) return false;
      const hasExtension = isSegmentation(extension, name);
      const nameMatchesPrimary = name.startsWith(primaryNamePrefix);
      return hasExtension && nameMatchesPrimary;
    })
    .map(({ importResult }) => importResult);
}

function getStudyUID(volumeID: string) {
  const dicomStore = useDICOMStore();
  const studyKey = dicomStore.volumeStudy[volumeID];
  return dicomStore.studyInfo[studyKey]?.StudyInstanceUID;
}

function findBaseDataSource(
  succeeded: Array<PipelineResultSuccess<ImportResult>>,
  segmentGroupExtension: string
) {
  const loadableDataSources = filterLoadableDataSources(succeeded);
  const baseDicom = findBaseDicom(loadableDataSources);
  if (baseDicom) return baseDicom;

  const baseImage = findBaseImage(loadableDataSources, segmentGroupExtension);
  if (baseImage) return baseImage;
  return loadableDataSources[0];
}

function filterOtherVolumesInStudy(
  volumeID: string,
  succeeded: Array<PipelineResultSuccess<ImportResult>>
) {
  const targetStudyUID = getStudyUID(volumeID);
  const dicomDataSources = filterLoadableDataSources(succeeded).filter(
    ({ dataType }) => dataType === 'dicom'
  );
  return dicomDataSources.filter((ds) => {
    const sourceStudyUID = getStudyUID(ds.dataID);
    return sourceStudyUID === targetStudyUID && ds.dataID !== volumeID;
  }) as Array<VolumeResult>;
}

// Layers a DICOM PET on a CT if found
function loadLayers(
  primaryDataSource: VolumeResult,
  succeeded: Array<PipelineResultSuccess<ImportResult>>
) {
  if (primaryDataSource.dataType !== 'dicom') return;
  const otherVolumesInStudy = filterOtherVolumesInStudy(
    primaryDataSource.dataID,
    succeeded
  );
  const dicomStore = useDICOMStore();
  const primaryModality =
    dicomStore.volumeInfo[primaryDataSource.dataID].Modality;
  if (primaryModality !== 'CT') return;
  // Look for one PET volume to layer with CT.  Only one as there are often multiple "White Balance" corrected PET volumes.
  const toLayer = otherVolumesInStudy.find((ds) => {
    const otherModality = dicomStore.volumeInfo[ds.dataID].Modality;
    return otherModality === 'PT';
  });
  if (!toLayer) return;

  const primarySelection = toDataSelection(primaryDataSource);
  const layersStore = useLayersStore();
  const layerSelection = toDataSelection(toLayer);
  layersStore.addLayer(primarySelection, layerSelection);
}

// Loads other DataSources as Segment Groups:
// - DICOM SEG modalities with matching StudyUIDs.
// - DataSources that have a name like foo.segmentation.bar and the primary DataSource is named foo.baz
function loadSegmentations(
  primaryDataSource: VolumeResult,
  succeeded: Array<PipelineResultSuccess<ImportResult>>,
  segmentGroupExtension: string
) {
  const matchingNames = filterMatchingNames(
    primaryDataSource,
    succeeded,
    segmentGroupExtension
  ).filter(
    isVolumeResult // filter out models
  );

  const dicomStore = useDICOMStore();
  const otherSegVolumesInStudy = filterOtherVolumesInStudy(
    primaryDataSource.dataID,
    succeeded
  ).filter((ds) => {
    const modality = dicomStore.volumeInfo[ds.dataID].Modality;
    if (!modality) return false;
    return modality.trim() === 'SEG';
  });

  const segmentGroupStore = useSegmentGroupStore();
  [...otherSegVolumesInStudy, ...matchingNames].forEach((ds) => {
    const loadable = toDataSelection(ds);
    segmentGroupStore.convertImageToLabelmap(
      loadable,
      toDataSelection(primaryDataSource)
    );
  });
}

function loadDataSources(sources: DataSource[], volumeKeySuffix?: string) {
  const load = async () => {
    const loadDataStore = useLoadDataStore();
    const dataStore = useDatasetStore();
    const viewStore = useViewStore();

    let results: ImportDataSourcesResult[];
    try {
      results = await importDataSources(sources, volumeKeySuffix);
    } catch (error) {
      loadDataStore.setError(error as Error);
      return;
    }

    const [succeeded, errored] = partitionResults(results);

    if (volumeKeySuffix) {
      const { layoutName } = loadDataStore.getLoadedByBus(volumeKeySuffix);
      if (layoutName) {
        viewStore.setLayoutByName(layoutName);
      }
    }
    if ((true || !dataStore.primarySelection) && succeeded.length) {
      const primaryDataSource = findBaseDataSource(
        succeeded,
        loadDataStore.segmentGroupExtension
      );

      if (isVolumeResult(primaryDataSource)) {
        const selection = toDataSelection(primaryDataSource);
        dataStore.setPrimarySelection(selection);
        loadLayers(primaryDataSource, succeeded);
        loadSegmentations(
          primaryDataSource,
          succeeded,
          loadDataStore.segmentGroupExtension
        );
      } // then must be primaryDataSource.type === 'model'
    }

    if (errored.length) {
      const errorMessages = errored.map((errResult) => {
        // pick first error
        const [firstError] = errResult.errors;
        // pick innermost dataset that errored
        const name = getDataSourceName(firstError.inputDataStackTrace[0]);
        // log error for debugging
        logError(firstError.cause);
        return `- ${name}: ${firstError.message}`;
      });
      const failedError = new Error(
        `These files failed to load:\n${errorMessages.join('\n')}`
      );

      loadDataStore.setError(failedError);
    }
  };

  const wrapWithLoading = <T extends (...args: any[]) => void>(fn: T) => {
    const { startLoading, stopLoading } = useLoadDataStore();
    return async function wrapper(...args: any[]) {
      try {
        startLoading();
        await fn(...args);
      } finally {
        stopLoading();
      }
    };
  };

  return wrapWithLoading(load)();
}

export function openFileDialog() {
  return new Promise<File[]>((resolve) => {
    const fileEl = document.createElement('input');
    fileEl.setAttribute('type', 'file');
    fileEl.setAttribute('multiple', 'multiple');
    fileEl.setAttribute('accept', '*');
    fileEl.addEventListener('change', () => {
      const files = [...(fileEl.files ?? [])];
      resolve(files);
    });
    fileEl.click();
  });
}

export async function loadFiles(files: File[], volumeKeySuffix?: string) {
  const dataSources = files.map(fileToDataSource);
  return loadDataSources(dataSources, volumeKeySuffix);
}

export async function loadUserPromptedFiles() {
  const files = await openFileDialog();
  return loadFiles(files);
}

export async function loadUrls(params: UrlParams, options?: LoadEventOptions) {
  const urls = wrapInArray(params.urls);
  const names = wrapInArray(params.names ?? []); // optional names should resolve to [] if params.names === undefined
  const sources = urls.map((url, idx) =>
    uriToDataSource(
      url,
      names[idx] ||
        basename(parseUrl(url, window.location.href).pathname) ||
        url
    )
  );
  // intercept load event from bus emitter
  if (options) {
    const loadDataStore = useLoadDataStore();
    const dataStore = useDatasetStore();
    const { volumeKeySuffix, ...loadOptions } = options;
    const onBeforeLoadedByBus = () => {
      loadDataStore.setLoadedByBus(volumeKeySuffix, loadOptions);
      // can do other preparations ...
      return loadDataStore.getLoadedByBus(volumeKeySuffix);
    };
    const onAfterLoadedByBus = async () => {
      const selection = dataStore.primarySelection;
      if (volumeKeySuffix && selection) {
        const tryGetImageID = async (retryCount = 100) => {
          let imageID;
          while (!imageID && retryCount > 0) {
            imageID = getImageID(selection);
            // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
            await new Promise(r => setTimeout(r, 10));
            // eslint-disable-next-line no-param-reassign
            retryCount--;
          }
          return imageID;
        };
        const imageID = await tryGetImageID();
        if (imageID) {
          loadDataStore.setLoadedByBus(volumeKeySuffix, { ...loadDataStore.getLoadedByBus(volumeKeySuffix), imageID });
        }
      }
      // loaded by bus done ...
    };
    const dicomWebURL = params.dicomWebURL?.toString();
    if (dicomWebURL) {
      const dicomWebFiles: File[] = [];
      const studyInstanceUID = params.studyInstanceUID?.toString();
      const seriesInstanceUID = params.seriesInstanceUID?.toString();
      const sopInstanceUID = params.sopInstanceUID?.toString();
      if (studyInstanceUID && seriesInstanceUID) {
        if (sopInstanceUID) {
          try {
            const file = await fetchInstance(dicomWebURL, {
              studyInstanceUID,
              seriesInstanceUID,
              sopInstanceUID,
            });
            dicomWebFiles.push(file);
          } catch (error) {
            console.error(error);
          }
        } else {
          try {
            const files = await fetchSeries(dicomWebURL, {
              studyInstanceUID,
              seriesInstanceUID,
            }, ({ loaded, total }: ProgressEvent) => {
              console.info(`fetching series ${loaded} of ${total}`);
            });
            dicomWebFiles.push(...files);
          } catch (error) {
            console.error(error);
          }
        }
      }
      return onBeforeLoadedByBus() && loadFiles(dicomWebFiles, volumeKeySuffix).then(onAfterLoadedByBus);
    }
    return onBeforeLoadedByBus() && loadDataSources(sources, volumeKeySuffix).then(onAfterLoadedByBus);
  }

  return loadDataSources(sources);
}
