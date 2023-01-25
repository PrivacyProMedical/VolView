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
  PatientID: '00100020',
  PatientName: '00100010',
  PatientBirthDate: '00100030',
  PatientSex: '00100040',

  StudyID: '00200010',
  StudyInstanceUID: '0020000D',
  StudyName: '00100010',
  StudyDate: '00080020',
  StudyTime: '00080030',
  AccessionNumber: '00080050',
  StudyDescription: '00081030',

  SeriesInstanceUID: '0020000E',
  SeriesNumber: '00200011',
  SeriesDescription: '0008103E',
  Modality: '00080060',

  SopInstanceUID: '00080018',
  InstanceNumber: '00200013',

  Rows: '00280010',
  Columns: '00280011',
};

export type Instance = typeof tags;

function parseTag(value: any) {
  const v = value?.Value?.[0];
  const alpha = v?.Alphabetic;
  if (alpha) return alpha;
  return v;
}

function parseInstance(instance: any): Instance {
  return Object.entries(tags).reduce(
    (info, [key, tag]) => ({ ...info, [key]: parseTag(instance[tag]) }),
    {}
  ) as Instance;
}

// Create unique file names so loader utils work
let fileCounter = 0;
function toFile(instance: ArrayBuffer) {
  fileCounter++;
  return new File([new Blob([instance])], `dicom-web.${fileCounter}.dcm`);
}

function makeClient(dicomWebRoot: string) {
  return new api.DICOMwebClient({
    url: dicomWebRoot,
  });
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

export async function fetchInstanceThumbnail(
  dicomWebRoot: string,
  instance: FetchInstanceOptions
) {
  const client = makeClient(dicomWebRoot);
  const thumbnail = await client.retrieveInstanceRendered({
    ...instance,
    // @ts-ignore
    mediaTypes: [{ mediaType: 'image/jpeg' }],
    queryParams: { quality: '10' },
  });
  const arrayBufferView = new Uint8Array(thumbnail);
  const blob = new Blob([arrayBufferView], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}
