const EventEmitter = require("events").EventEmitter
const debug = require("debug")("AM43")

const StaticVariables = {
  AM43_SERVICE_ID: "fe50",
  AM43_CHARACTERISTIC_ID: "fe51",

  AM43_COMMAND_PREFIX: Uint8Array.from([0x00, 0xff, 0x00, 0x00, 0x9a]),
  AM43_COMMAND_ID_SET_MOVE: 0x0a,

  AM43_MOVE_OPEN: 0xdd,
  AM43_MOVE_CLOSE: 0xee,
  AM43_MOVE_STOP: 0xcc,

  AM43_COMMAND_ID_SET_POSITION: 0x0d,
  AM43_COMMAND_ID_GET_POSITION: 0xa7,
  AM43_COMMAND_ID_GET_LIGHTSENSOR: 0xaa,
  AM43_COMMAND_ID_GET_BATTERYSTATUS: 0xa2,

  AM43_RESPONSE_ACK: 0x5a,
  AM43_RESPONSE_NACK: 0xa5,

  AM43_NOTIFY_POSITION: 0xa1,

  POSITION_HISTORY_LENGTH: 6,
}

class AM43Device extends EventEmitter {
  constructor(peripheral) {
    super()

    this.peripheral = peripheral
    if (peripheral.localName) {
      this.name = peripheral.localName
    } else if (peripheral.advertisement.localName) {
      this.name = peripheral.advertisement.localName
    } else if (peripheral.address) {
      this.name = peripheral.address
    } else {
      let name = "AM43 Blind"
      if (peripheral.id) {
        name += " "
        name += peripheral.id
      }
      this.name = name
    }
    if (peripheral.id) {
      this.id = peripheral.id
    } else if (peripheral.uuid) {
      this.id = peripheral.uuid
    } else if (peripheral.address) {
      this.id = peripheral.address
    } else {
      this.id = this.name
    }
    this.address = peripheral.address

    let addressDesc =
      this.peripheral.address != null
        ? this.peripheral.address
        : this.peripheral.id
    this.description = this.name + " (" + addressDesc + ")"

    this.isConnected = false
    this.peripheral.on("connect", () => {
      this.logDebug(`Device connected: ${this.id}`)
      this.isConnected = true
    })
    this.peripheral.on("disconnect", () => {
      this.logDebug(`Device disconnected: ${this.id}`)
      this.isConnected = false
    })
    this.blindsControlCharacteristic = null
    this.position = 0
    this.targetPosition = null
    this.direction = 2 // 0: Down/Decreating, 1: Up/Increasing, 2: Stopped
    this.batteryPercentage = 50

    this.positionHistory = []
  }

  logDebug(info) {
    if (this.log) {
      this.log.debug(`${this.description}: ${info}`)
    } else {
      debug(`${this.description}: ${info}`)
    }
  }

  logInfo(info) {
    if (this.log) {
      this.log.info(`${this.description}: ${info}`)
    } else {
      debug(`${this.description}: ${info}`)
    }
  }

  setBlindsControlCharacteristic(characteristic) {
    this.blindsControlCharacteristic = characteristic
    this.blindsControlCharacteristic.on("data", (data) => {
      this.logDebug("--------Notification--------")
      const dataArray = new Uint8Array(data)
      this.logDebug(`Data received:` + dataArray)
      let percentage = null

      switch (data[1]) {
        case StaticVariables.AM43_COMMAND_ID_GET_POSITION:
          this.logDebug("Position update received")
          percentage = parseInt(dataArray[5])
          if (percentage >= 99) percentage = 100
          if (percentage <= 1) percentage = 0
          this.logDebug(`Closed Percentage ${percentage}`)
          this.position = percentage

          this.positionHistory.unshift(percentage)
          this.positionHistory.length = Math.min(
            StaticVariables.POSITION_HISTORY_LENGTH,
            this.positionHistory.length
          )

          this.emit("position", this.position)
          break

        case StaticVariables.AM43_COMMAND_ID_GET_LIGHTSENSOR:
          this.logDebug("light sensor update received")
          percentage = parseInt(dataArray[4])
          this.logDebug(`Light level ${percentage}`)
          this.emit("lightLevel", percentage)
          break

        case StaticVariables.AM43_COMMAND_ID_GET_BATTERYSTATUS:
          this.logDebug("Battery Status update received")
          percentage = parseInt(dataArray[7])
          this.logDebug(`Battery Percentage ${percentage}`)
          this.batteryPercentage = percentage
          this.emit("batteryPercentage", this.batteryPercentage)
          break

        case StaticVariables.AM43_NOTIFY_POSITION:
          this.logDebug("Position notify received")
          percentage = parseInt(dataArray[4])
          this.logDebug(`Closed Percentage ${percentage}`)
          this.position = percentage

          this.positionHistory.unshift(percentage)
          this.positionHistory.length = Math.min(
            StaticVariables.POSITION_HISTORY_LENGTH,
            this.positionHistory.length
          )

          this.emit("position", this.position)
          break

        case StaticVariables.AM43_COMMAND_ID_SET_MOVE:
          this.logDebug("Set move notify received")
          if (dataArray[3] == StaticVariables.AM43_RESPONSE_ACK) {
            this.logDebug("Set move acknowledged")
          } else if (dataArray[3] == AM43_RESPONSE_NACK) {
            this.logDebug("Set move denied")
          }
          break

        case StaticVariables.AM43_COMMAND_ID_SET_POSITION:
          this.logDebug("Set position notify received")
          if (dataArray[3] == StaticVariables.AM43_RESPONSE_ACK) {
            this.logDebug("Set position acknowledged")
          } else if (dataArray[3] == StaticVariables.AM43_RESPONSE_NACK) {
            this.logDebug("Set position denied")
          }
          break

        default:
          break
      }

      if (this.targetPosition != null && this.position != null) {
        let direction = this.targetPosition < this.position ? 1 : 0
        let targetPosition = this.targetPosition
        if (this.position == this.targetPosition || this.checkIfStopped()) {
          this.logDebug(
            `Target position ${this.targetPosition} reached @ ${this.position}`
          )
          targetPosition = null
        }
        if (targetPosition == null) {
          direction = 2
        }
        if (direction != this.direction) {
          this.direction = direction
          this.emit("direction", this.direction)
        }
        if (targetPosition != this.targetPosition) {
          this.targetPosition = targetPosition
          this.emit("targetPosition", this.targetPosition)
        }
      }
    })

    this.blindsControlCharacteristic.subscribe((error) => {
      if (error) {
        this.logDebug("Failed to subsribe to notifications")
      } else {
        this.logDebug("Subscribed to notifications")
      }
    })

    this.connectingPromise = null
    this.discoveringPromise = null
  }

  async prepareAsync() {
    if (!this.isConnected) {
      await this.connectAsync()
    }
    await this.updatePositionAsync()
  }

  async connectAsync() {
    this.logDebug("connectAsync")
    if (!this.isConnected) {
      if (this.connectingPromise == null) {
        this.connectingPromise = this.peripheral.connectAsync()
      }
      await this.connectingPromise
      this.connectingPromise = null

      await new Promise((r) => setTimeout(r, 200))

      if (!this.isConnected) {
        return
      }
    }

    if (this.blindsControlCharacteristic == null) {
      if (this.discoveringPromise == null) {
        this.logDebug("waitingForDiscoveringPromise")
        this.discoveringPromise = this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [StaticVariables.AM43_SERVICE_ID],
          [StaticVariables.AM43_CHARACTERISTIC_ID]
        )
        
        const { characteristics } = await this.discoveringPromise
        this.discoveringPromise = null
        this.logDebug("setBlindsControlCharacteristic")
        this.setBlindsControlCharacteristic(characteristics[0])
      } else {
        await this.discoveringPromise
      }
    }
  }

  async disconnectAsync() {
    this.logDebug("disconnectAsync")
    this.isConnected = false
    this.connectingPromise = null
    this.discoveringPromise = null
    this.blindsControlCharacteristic = null
    await this.peripheral.disconnectAsync()
  }

  async enableNotificationsAsync() {
    try {
      await this.blindsControlCharacteristic.subscribeAsync()
      this.logDebug("Subscribed to notifications")
    } catch (e) {
      this.logDebug("Failed to subsribe to notifications")
    }
  }

  async setPositionAsync(position, trackPosition) {
    this.targetPosition = position
    await this.sendCommandAsync(StaticVariables.AM43_COMMAND_ID_SET_POSITION, [
      position,
    ])
    if (trackPosition == true) {
      this.positionHistory = []
      this.trackCurrentPosition()
    }
  }

  trackCurrentPosition() {
    setTimeout(async () => {
      await this.updatePositionAsync()
      if (this.targetPosition != null) {
        this.trackCurrentPosition()
      }
    }, 1000)
  }

  checkIfStopped() {
    this.logDebug("[checkIfStopped] " + this.positionHistory)
    if (this.positionHistory.length < StaticVariables.POSITION_HISTORY_LENGTH)
      return false
    return this.positionHistory.every((v) => v === this.positionHistory[0])
  }

  async openAsync() {
    this.targetPosition = 0
    this.direction = 1
    await this.sendCommandAsync(StaticVariables.AM43_COMMAND_ID_SET_MOVE, [
      AM43_MOVE_OPEN,
    ])
    this.emit("direction", this.direction)
    this.emit("targetPosition", this.targetPosition)
  }

  async closeAsync() {
    this.targetPosition = 100
    this.direction = 0
    await this.sendCommandAsync(StaticVariables.AM43_COMMAND_ID_SET_MOVE, [
      AM43_MOVE_CLOSE,
    ])
    this.emit("direction", this.direction)
    this.emit("targetPosition", this.targetPosition)
  }

  async stopAsync() {
    this.targetPosition = null
    this.direction = 2
    await this.sendCommandAsync(StaticVariables.AM43_COMMAND_ID_SET_MOVE, [
      AM43_MOVE_STOP,
    ])
    this.emit("direction", this.direction)
    this.emit("targetPosition", this.targetPosition)
  }

  async updatePositionAsync() {
    await this.sendCommandAsync(StaticVariables.AM43_COMMAND_ID_GET_POSITION, [
      0x1,
    ])
  }

  async updateBatteryStatusAsync() {
    await this.sendCommandAsync(
      StaticVariables.AM43_COMMAND_ID_GET_BATTERYSTATUS,
      [0x1]
    )
  }

  async updateLightSensorAsync() {
    await this.sendCommandAsync(
      StaticVariables.AM43_COMMAND_ID_GET_LIGHTSENSOR,
      [0x1]
    )
  }

  async sendCommandAsync(commandID, data) {
    if (!this.isConnected || this.blindsControlCharacteristic == null || this.blindsControlCharacteristic == undefined) {
      await this.connectAsync()
      if (!this.isConnected || this.blindsControlCharacteristic == null || this.blindsControlCharacteristic == undefined) {
        return
      }
    }
    this.logDebug("--------Command--------")
    this.logDebug(`Sending command to device: ${this.id}`)
    const bufferArray = new Uint8Array(data.length + 8)
    const startPackage = StaticVariables.AM43_COMMAND_PREFIX
    for (let index = 0; index < startPackage.length; index++) {
      bufferArray[index] = startPackage[index]
    }
    bufferArray[5] = commandID
    const uIntData = Uint8Array.from(data)
    bufferArray[6] = uIntData.length
    let bufferIndex = 7
    for (let index = 0; index < uIntData.length; index++) {
      bufferArray[bufferIndex] = uIntData[index]
      bufferIndex++
    }
    bufferArray[bufferIndex] = this.calculateCommandChecksum(bufferArray)
    bufferIndex++

    const buffer = Buffer.from(bufferArray.buffer)
    let hexString = buffer.toString("hex")
    this.logDebug(`Sending command: ${hexString}`)
    this.logDebug(`Blinds characteristic available: ${this.blindsControlCharacteristic !== null && this.blindsControlCharacteristic !== undefined}`)
    try {
      await this.blindsControlCharacteristic.writeAsync(buffer, true)
    } catch (error) {
      this.logDebug(`Failed write command with error: ${error}`)
    }
  }

  calculateCommandChecksum(bufferArray) {
    let checksum = 0
    for (let i = 0; i < bufferArray.length - 1; i++) {
      checksum = checksum ^ bufferArray[i]
    }
    checksum = checksum ^ 0xff
    return checksum
  }
}

module.exports = {
  AM43Device: AM43Device,
  StaticVariables: StaticVariables,
}
