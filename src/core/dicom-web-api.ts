import { cleanUndefined } from '@/src/utils';
import { api } from 'dicomweb-client-typed';

export interface FetchStudyOptions {
  studyInstanceUID: string;
}

export interface FetchSeriesOptions extends FetchStudyOptions {
  seriesInstanceUID: string;
}

export interface FetchInstanceOptions extends FetchSeriesOptions {
  sopInstanceUID: string;
}

const tags = {
  // Patient
  PatientName: '00100010',
  PatientID: '00100020',
  PatientBirthDate: '00100030',
  PatientSex: '00100040',
  // Study
  StudyInstanceUID: '0020000D',
  StudyID: '00200010',
  StudyName: '00100010',
  StudyDate: '00080020',
  StudyTime: '00080030',
  StudyDescription: '00081030',
  AccessionNumber: '00080050',
  InstitutionName: '00080080',
  ManufacturerModelName: '00081090',
  // Series
  Modality: '00080060',
  BodyPartExamined: '00180015',
  // TransferSyntaxUID: '00020010',
  SeriesInstanceUID: '0020000E',
  SeriesNumber: '00200011',
  SeriesDescription: '0008103E',
  // Instance
  SopInstanceUID: '00080018',
  InstanceNumber: '00200013',

  Rows: '00280010',
  Columns: '00280011',

  WindowLevel: '00281050',
  WindowWidth: '00281051',
};

export type Instance = typeof tags;

function parseTag(value: any) {
  const v = value?.Value?.[0];
  const alpha = v?.Alphabetic;
  if (alpha) return alpha;
  return v;
}

function parseInstance(instance: any) {
  const withNamedTags = Object.entries(tags).reduce(
    (info, [key, tag]) => ({ ...info, [key]: parseTag(instance[tag]) }),
    {}
  );
  return cleanUndefined(withNamedTags) as Instance;
}

// Create unique file names so loader utils work
let fileCounter = 0;
function toFile(instance: ArrayBuffer) {
  fileCounter++;
  return new File([new Blob([instance])], `dicom-web.${fileCounter}.dcm`);
}

// Singleton pattern?
let dicomWebClient: api.DICOMwebClient | null = null;
function makeClient(dicomWebRoot: string) {
  if (dicomWebClient !== null) {
    return dicomWebClient;
  }
  dicomWebClient = new api.DICOMwebClient({
    url: dicomWebRoot,
  });
  return dicomWebClient;
}

export async function searchForStudies(dicomWebRoot: string) {
  const client = makeClient(dicomWebRoot);
  const instances = await client.searchForStudies();
  return instances.map(parseInstance);
}

export async function retrieveStudyMetadata(
  dicomWebRoot: string,
  options: FetchStudyOptions
) {
  const client = makeClient(dicomWebRoot);
  const instances = await client.searchForSeries(options);
  return instances.map(parseInstance);
}

export async function retrieveSeriesMetadata(
  dicomWebRoot: string,
  options: FetchSeriesOptions
) {
  const client = makeClient(dicomWebRoot);
  const instances = await client.retrieveSeriesMetadata(options);
  return instances.map(parseInstance);
}

export async function retrieveInstanceMetadata(
  dicomWebRoot: string,
  options: FetchInstanceOptions
) {
  const client = makeClient(dicomWebRoot);
  const instance = await client.retrieveInstanceMetadata(options);
  return parseInstance(instance);
}

export async function fetchSeries(
  dicomWebRoot: string,
  options: FetchSeriesOptions,
  progressCallback: (n: ProgressEvent) => void
): Promise<File[]> {
  const client = makeClient(dicomWebRoot);
  const series = (await client.retrieveSeries({
    ...options,
    progressCallback,
  })) as ArrayBuffer[];
  return series.map(toFile);
}

export async function fetchInstance(
  dicomWebRoot: string,
  instance: FetchInstanceOptions
) {
  const client = makeClient(dicomWebRoot);
  const dicom = await client.retrieveInstance({
    ...instance,
  }) as ArrayBuffer;
  return toFile(dicom);
}

export async function fetchInstanceThumbnail(
  dicomWebRoot: string,
  instance: FetchInstanceOptions
) {
  const client = makeClient(dicomWebRoot);
  const thumbnail = await client.retrieveInstanceRendered({
    ...instance,
    mediaTypes: [{ mediaType: 'image/jpeg' }],
  });
  const arrayBufferView = new Uint8Array(thumbnail);
  const blob = new Blob([arrayBufferView], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

const LEVELS = ['series', 'studies'] as const;

// takes a url like http://localhost:3000/dicom-web/studies/someid/series/anotherid
// returns { host: 'http://localhost:3000/dicom-web', studies: 'someid', series: 'anotherid' }
export function parseUrl(deepDicomWebUrl: string) {
  // remove trailing slash
  const sansSlash = deepDicomWebUrl.replace(/\/$/, '');

  let paths = sansSlash.split('/');
  const parentIDs = LEVELS.reduce((idObj, dicomLevel) => {
    const [urlLevel, dicomID] = paths.slice(-2);
    if (urlLevel === dicomLevel) {
      paths = paths.slice(0, -2);
      return { [dicomLevel]: dicomID, ...idObj };
    }
    return idObj;
  }, {});

  const pathsToSlice = Object.keys(parentIDs).length * 2;
  const allPaths = sansSlash.split('/');
  const host = allPaths.slice(0, allPaths.length - pathsToSlice).join('/');

  return { host, ...parentIDs };
}
