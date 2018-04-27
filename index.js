import fs from 'fs'
import path from 'path'
import moment from 'moment-timezone'
import yichan from 'yichan'
import sharp from 'sharp'
import { CronJob } from 'cron'

class BauCam {
  constructor () {
    this.timeZone = 'Europe/Berlin'
    this.localPath = './storage'
    this.remotePath = '/tmp/fuse_d/DCIM'
    this.maxFilesToCopyPerTask = 25
    this.maxFilesToDeletePerTask = 100

    this.state = {}
    this.cam = new yichan()

    this.tasks = {
      capture: {cron: '0 */5 * * * *', action: () => this.capture()},
      copy: {cron: '0 */5 * * * *', action: () => this.copy()},
      cleanup: {cron: '0 0 */4 * * *', action: () => this.cleanup()}
    }
  }

  capture () {
    return new Promise(async (resolve, reject) => {
      this.log('Capturing...')
      await this.clock()
      this.cam.capturePhoto((error, path) => {
        error && reject(error)
        this.log(`Captured to ${path}.`)
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

  copy () {
    return new Promise(async (resolve, reject) => {
      this.log('Copying files from camera...')
      const images = await this.getRemoteImages()
      let copied = 0
      let lastFile = null
      for (let i = 0; i < images.length; i++) {
        if (copied >= this.maxFilesToCopyPerTask) {
          break
        }
        await new Promise((resolve, reject) => {
          const image = images[i]
          const localPath = this.getLocalStoragePath(image.file, true)
          if (fs.existsSync(localPath)) {
            const stats = fs.statSync(localPath)
            if (stats.size === image.file.size) {
              //this.log(`Skipping ${localPath}...`)
              resolve()
              return
            }
          }
          copied++
          this.log(`Copying ${image.path} -> ${localPath}...`)
          const stream = fs.createWriteStream(localPath)
          const src = this.cam.createReadStream(image.path)
          src.on('error', reject)
          src.on('end', () => {
            lastFile = localPath
            resolve()
          })
          src.pipe(stream)
        })
      }
      if (lastFile) {
        await this.copySnapshot(lastFile)
      }
      resolve()
    })
  }

  cleanup () {
    return new Promise(async (resolve) => {
      this.log('Cleaning up old files from camera...')
      const images = await this.getRemoteImages()
      let deleted = 0
      for (let i = 0; i < images.length; i++) {
        if (deleted >= this.maxFilesToDeletePerTask) {
          break
        }
        await new Promise((resolve) => {
          const image = images[i]
          const localPath = this.getLocalStoragePath(image.file)
          if (!fs.existsSync(localPath)) {
            resolve()
            return
          }
          const stats = fs.statSync(localPath)
          if (stats.size !== image.file.size) {
            resolve()
            return
          }
          this.log(`Deleting ${image.path}...`)
          deleted++
          this.cam.deleteFile(image.path, (err, res) => {
            err && reject(err)
            resolve()
          })
        })
      }
      resolve()
    })
  }

  async copySnapshot (file) {
    if (fs.existsSync(file)) {
      this.log(`Copying snapshot from ${file}...`)
      const localPath = path.resolve(this.localPath)
      const target = localPath + '/snapshot.jpg'
      const tmpTarget = localPath + '/snapshot.tmp.jpg'
      await sharp(file)
        .resize(2048, 1536)
        .max()
        .rotate(180)
        .toFile(tmpTarget)
      fs.renameSync(tmpTarget, target)
    }
  }

  now () {
    return moment().tz('Europe/Berlin')
  }

  getLocalFileName (file, date = null) {
    return (date ? date : moment(file.date))
        .format('YYYYMMDD_HHmmss') + '_' + file.name
  }

  getLocalStoragePath (file, create = false) {
    const date = moment(file.date)
    const localPath = path.resolve(this.localPath) + '/' + date.format('YYYYMMDD')
    if (create) {
      fs.existsSync(localPath) || fs.mkdirSync(localPath)
    }
    return localPath + '/' + this.getLocalFileName(file, date)
  }

  getRemoteImages () {
    return new Promise(async (resolve, reject) => {
      const dirs = await this.getRemoteDirs()
      const files = []
      for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i]
        await new Promise((resolve, reject) => {
          this.cam.listDirectory(dir, (error, images) => {
            error && reject(error)
            if (!images) {
              reject(`An error occurred while reading the remote images in '${dir}'.`)
            }
            images.forEach(file => files.push({path: dir + file.name, file}))
            resolve()
          })
        })
      }
      resolve(files)
    })
  }

  getRemoteDirs () {
    return new Promise((resolve, reject) => {
      const remotePath = path.resolve(this.remotePath)
      this.cam.listDirectory(remotePath, (error, parents) => {
        error && reject(error)
        if (!parents) {
          reject('An error occurred while reading the remote directories.')
        }
        resolve(parents.map(parent => remotePath + '/' + parent.name))
      })
    })
  }

  error (err) {
    console.error(err)
  }

  log (message) {
    console.log(message)
  }

  run () {
    for (const name in this.tasks) {
      const {cron, action} = this.tasks[name]
      new CronJob(cron, async () => {
        if (!this.state[name]) {
          try {
            this.state[name] = true
            await action()
          }
          catch (e) {
            this.error(e)
          }
          finally {
            this.state[name] = false
          }
        }
      }, null, true, this.timeZone)
    }
  }
}

const bc = new BauCam()
bc.run()