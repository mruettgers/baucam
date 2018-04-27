import fs from 'fs'
import moment from 'moment-timezone'
import yichan from 'yichan'
import sharp from 'sharp'

/*
 const TelegramBot = require('node-telegram-bot-api');
 const token = process.env.TELEGRAM_BOT_TOKEN;
 const bot = new TelegramBot(token, {polling: false});
 */

class BauCam {
  constructor (config = {}) {
    const {
      captureInterval = 60 * 5,
      localPath = './storage',
      remotePath = '/tmp/fuse_d/DCIM',
      maxFilesPerCopyTask = 50,
      maxFilesToDeletePerCleanupTask = 100
    } = config

    this.localPath = localPath
    this.remotePath = remotePath
    this.maxFilesPerCopyTask = maxFilesPerCopyTask
    this.maxFilesToDeletePerCleanupTask = maxFilesToDeletePerCleanupTask

    this.procs = [
      {method: 'capture', interval: captureInterval, from: 5, to: 23},
      {method: 'clock', interval: captureInterval - 60, from: 5, to: 23},
      //{method: 'copy', interval: captureInterval + 60, from: 5, to: 23},
      //{method: 'cleanup', interval: 60 * 55 * 4, from: 5, to: 23}
    ]

    this.state = {}
    this.cam = new yichan()
  }

  now () {
    return moment().tz('Europe/Berlin')
  }

  stripTrailingSlash (val) {
    return val.replace(/\/$/, '')
  }

  getLocalFileName (file, date = null) {
    return (date ? date : moment(file.date))
        .format('YYYYMMDD_HHmmss') + '_' + file.name
  }

  getLocalStoragePath (file, create = false) {
    const date = moment(file.date)
    const path = this.stripTrailingSlash(this.localPath)
      + '/' + date.format('YYYYMMDD')
    if (create) {
      fs.existsSync(path) || fs.mkdirSync(path)
    }
    return path + '/' + this.getLocalFileName(file, date)
  }

  capture () {
    return new Promise((resolve, reject) => {
      this.log('Capturing...')
      this.cam.capturePhoto((error, path) => {
        error && reject(error)
        this.log(`Captured to ${path}.`)
        resolve()
      })
    })
  }

  async copySnapshot (file) {
    if (fs.existsSync(file)) {
      this.log(`Copying snapshot from ${file}...`)
      const target = this.stripTrailingSlash(this.localPath) + '/snapshot.jpg'
      const tmpTarget = this.stripTrailingSlash(this.localPath) + '/snapshot.tmp.jpg'
      await sharp(file)
        .resize(2048, 1536)
        .max()
        .rotate(180)
        .toFile(tmpTarget)
      fs.renameSync(tmpTarget, target)
    }
  }

  copy () {
    return new Promise((resolve, reject) => {
      this.log('Copying files from camera...')
      this.cam.listDirectory(this.remotePath, async (error, res) => {
        error && reject(error)
        console.log(res)
        for (let j = 0; j < res.length; j++) {
          const remoteImgPath = this.stripTrailingSlash(this.remotePath) + '/' + res[j].name
          await new Promise((resolve, reject) => {
            this.cam.listDirectory(remoteImgPath, async (error, res) => {
              error && reject(error)
              let copied = 0
              let lastFile = null
              for (let i = 0; i < res.length; i++) {
                if (copied >= this.maxFilesPerCopyTask) {
                  await this.copySnapshot(lastFile)
                  resolve()
                  return
                }
                const file = res[i]
                const remotePath = this.stripTrailingSlash(remoteImgPath) + '/' + file.name
                const localPath = this.getLocalStoragePath(file, true)
                await new Promise((resolve, reject) => {
                  if (fs.existsSync(localPath)) {
                    const stats = fs.statSync(localPath)
                    if (stats.size === file.size) {
                      //this.log(`Skipping ${localPath}...`)
                      resolve()
                      return
                    }
                  }
                  copied++
                  this.log(`Copying ${remotePath} -> ${localPath}...`)
                  lastFile = localPath
                  const stream = fs.createWriteStream(localPath)
                  const src = this.cam.createReadStream(remotePath)
                  src.on('error', reject)
                  src.on('end', resolve)
                  src.pipe(stream)
                })
              }
              await this.copySnapshot(lastFile)
            })
          })
        }
        resolve()
      })
    })
  }

  cleanup () {
    return new Promise((resolve) => {
      this.log('Cleaning up old files from camera...')
      this.cam.listDirectory(this.remotePath, async (error, res) => {
        error && reject(error)
        for (let j = 0; j < res.length; j++) {
          const remoteImgPath = this.stripTrailingSlash(this.remotePath) + '/' + res[j].name
          await new Promise((resolve, reject) => {
            this.cam.listDirectory(remoteImgPath, async (error, res) => {
              error && reject(error)
              let deleted = 0
              for (let i = 0; i < res.length; i++) {
                if (deleted >= this.maxFilesToDeletePerCleanupTask) {
                  resolve()
                  return
                }
                const file = res[i]
                const remotePath = this.stripTrailingSlash(remoteImgPath) + '/' + file.name
                const localPath = this.getLocalStoragePath(file, true)
                await new Promise((resolve, reject) => {
                  if (fs.existsSync(localPath)) {
                    const stats = fs.statSync(localPath)
                    if (stats.size === file.size) {
                      this.log(`Deleting file '${remotePath}...`)
                      deleted++
                      this.cam.deleteFile(remotePath, (err, res) => {
                        err && reject(err)
                        resolve()
                      })
                    }
                  }
                })
              }
            })
          })
        }
        resolve()
      })
    })
  }

  clock () {
    return new Promise((resolve, reject) => {
      this.log('Setting clock...')
      const dateTime = this.now().format('YYYY-MM-DD HH:mm:ss')
      this.cam.sendCmd({msg_id: 2, type: 'camera_clock', param: dateTime}, (error, res) => {
        error && reject(error)
        this.log(`Set clock to ${dateTime}.`)
        resolve(res)
      })
    })
  }

  process (i) {
    this.procs.forEach(({interval, method, from, to}) => {
      if (i % interval === 0) {
        if (!this.state[method]) {
          const hour = parseInt(this.now().format('HH'))
          if (hour >= from && hour < to) {
            this.state[method] = true
            this[method]()
              .then(() => {
                this.state[method] = false
              })
              .catch(error => {
                this.state[method] = false
                this.error(error)
              })
          }
          else {
            this.log(`Won't run method '${method}' now because it should run between ${from} and ${to} o'clock only.`)
          }
        }
      }
    })
  }

  run (i = 1) {
    this.process(i)
    setTimeout(() => {
      this.run(++i)
    }, 1000)
  }

  log (message) {
    console.log(message)
  }

  error (error) {
    console.log(error)
  }

}

const bc = new BauCam()
bc.run()