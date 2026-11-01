const config = require('../config/env');
const { LocalDiskStorage } = require('./localDisk');

let instance;
module.exports = { getStorage: () => (instance ||= new LocalDiskStorage(config.MEDIA_DIR)) };
