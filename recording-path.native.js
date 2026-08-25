import RNFS from 'react-native-fs';

export function localWavPath(id) {
  return `${RNFS.DocumentDirectoryPath}/meeting-${id}.wav`;
}
