import { fetchFile } from '@/src/utils/fetch';
import { getURLBasename, partition } from '@/src/utils';
import {
  StateFile,
  DatasetType,
  Dataset,
  Manifest,
  RemoteDatasetFileEntry,
} from './schema';
import {
  DatasetFile,
  isRemote,
  makeRemote,
  RemoteDatasetFile,
  useFileStore,
} from '../../store/datasets-files';
import { FileEntry } from '../types';
import { extractArchivesRecursively, retypeFile } from '../io';

export async function serializeData(
  stateFile: StateFile,
  dataIDs: string[],
  dataType: DatasetType
) {
  const fileStore = useFileStore();
  const { zip } = stateFile;
  const {
    manifest: { datasets, remoteDatasetFileEntries },
  } = stateFile;

  dataIDs.forEach((id) => {
    const files = fileStore.getDatasetFiles(id);
    if (!files.length) {
      throw new Error(`No files for dataID: ${id}`);
    }

    const [remoteFiles, zipFiles] = partition(isRemote, files) as [
      Array<RemoteDatasetFile>,
      Array<DatasetFile>
    ];

    remoteDatasetFileEntries[id] = remoteFiles
      .map((f) => ({ path: '', ...f }))
      .map(({ url, path, file: { name } }) => ({
        url,
        path,
        name,
      }));

    const dataPath = `data/${id}/`;

    zipFiles.forEach(({ file }) => {
      const filePath = `${dataPath}/${file.name}`;
      zip.file(filePath, file);
    });

    datasets.push({
      id,
      path: dataPath,
      type: dataType,
    });
  });
}

type RemoteFileCache = Record<string, DatasetFile[] | Promise<DatasetFile[]>>;

const getRemoteFile = () => {
  const cache: RemoteFileCache = {};

  return async ({
    url,
    path: remoteFilePath,
    name: remoteFileName,
  }: RemoteDatasetFileEntry) => {
    if (!(url in cache)) {
      cache[url] = fetchFile(url, getURLBasename(url))
        .then((remoteFile) => retypeFile(remoteFile))
        .then((remoteFile) =>
          extractArchivesRecursively([makeRemote(url)(remoteFile)])
        );
      cache[url] = await cache[url];
    }
    // ensure parallel remote file requests have resolved
    const remoteFiles = await cache[url];

    const file = remoteFiles
      .map((f) => ({ path: '', ...f }))
      .find(
        ({ path, file: { name } }) =>
          path === remoteFilePath && name === remoteFileName
      );

    console.log(remoteFiles);

    if (!file)
      throw new Error(
        `Did not find matching file in remote file URL: ${url} : ${remoteFilePath} : ${remoteFileName}`
      );

    return file;
  };
};

export const deserializeDatasetFiles = (
  manifest: Manifest,
  savedFiles: FileEntry[]
) => {
  const getFile = getRemoteFile();

  return async ({ id, path }: Dataset) => {
    const filesInStateFile = savedFiles.filter((entry) => entry.path === path);

    const remoteFiles = await Promise.all(
      manifest.remoteDatasetFileEntries[id].map(getFile)
    );
    return [...filesInStateFile, ...remoteFiles];
  };
};
