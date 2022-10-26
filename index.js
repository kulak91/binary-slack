'use strict';

// Dependency
// for local tests:
require('dotenv').config();
const pm2 = require('pm2');
const pmx = require('pmx').initModule();
const app = require('./slack-receiver');
const MessageQueue = require('./message-queue');
const { parseIncommingLog, parseProcessName } = require('./utils');

/**
 * Get the configuration from PM2
 *
 * @type {Object}
 * @property {boolean} exception
 */



// const process.env = pmx.initModule();

const slackUrlRouter = {
  /**
   * Keys are slackUrls, values are instances of MessageQueue
   *
   * @typedef {Object.<string, MessageQueue>}
   */
  messageQueues: {},


  /**
   * Add the message to appropriate message queue (each Slack URL has own independent message enqueing).
   *
   * @param {Message} message
   */
  addMessage: function (message) {
    const processName = message.name;
    const slackUrl = process.env['slack_url-' + processName] || process.env['slack_url'];

    if (!slackUrl) {
      return;
    }

    if (!this.messageQueues[slackUrl]) {
      // Init new messageQueue to different Slack URL.

      // Resolve configuration parameters.
      const configProperties = ['username', 'servername', 'buffer', 'slack_url', 'buffer_seconds', 'buffer_max_seconds', 'queue_max'];
      const config = {};
      configProperties.map((configPropertyName) => {
        // Use process based custom configuration values if exist, else use the global configuration values.
        config[configPropertyName] = process.env[configPropertyName + '-' + processName] || process.env[configPropertyName];
      });

      this.messageQueues[slackUrl] = new MessageQueue(config);
    }

    this.messageQueues[slackUrl].addMessageToQueue(message);

  }
};


// ----- APP INITIALIZATION -----

// Start listening on the PM2 BUS
pm2.launchBus(function (err, bus) {

  // Listen for process logs
  if (process.env.log) {
    bus.on('log:out', function (data) {
      // if (data.process.name === 'pm2-slack-plus') { return; } // Ignore messages of own module.
      const parsedLog = parseIncommingLog(data.data);
      slackUrlRouter.addMessage({
        name: parseProcessName(data.process),
        event: 'log',
        description: parsedLog.description,
        timestamp: parsedLog.timestamp,
      });
    });
  }

  // Listen for process errors
  if (process.env.error) {
    bus.on('log:err', function (data) {


      if (data.data.includes('DeprecationWarning')) return;
      // if (data.process.name === 'pm2-slack-plus') { return; } // Ignore messages of own module.
      const parsedLog = parseIncommingLog(data.data);
      slackUrlRouter.addMessage({
        name: parseProcessName(data.process),
        event: 'error',
        description: parsedLog.description,
        timestamp: parsedLog.timestamp,
      });
    });
  }

  // Listen for PM2 kill
  if (process.env.kill) {
    bus.on('pm2:kill', function (data) {
      slackUrlRouter.addMessage({
        name: 'PM2',
        event: 'kill',
        description: data.msg,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  // Listen for process exceptions
  if (process.env.exception) {
    bus.on('process:exception', function (data) {
      if (data.process.name === 'pm2-slack-plus') { return; } // Ignore messages of own module.

      // If it is instance of Error, use it. If type is unknown, stringify it.
      const description = (data.data && data.data.message) ? (data.data.code || '') + data.data.message : JSON.stringify(data.data);
      slackUrlRouter.addMessage({
        name: parseProcessName(data.process),
        event: 'exception',
        description: description,
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  // Listen for PM2 events
  bus.on('process:event', function (data) {
    if (!process.env[data.event] && data.event !== 'restart overlimit') { return; } // This event type is disabled by configuration.
    if (data.process.name === 'pm2-slack-plus') { return; } // Ignore messages of own module.

    let description = null;
    let interactive = [];
    switch (data.event) {
      case 'start':
      case 'online':
        description = `${data.process.name} started`;
        break;
      case 'stop':
        description = 'App stopped.';
        break;
      case 'restart':
        description = 'App restarted.';
        break;
      case 'exit':
        description = 'App closed.';
        break;
      case 'restart overlimit':
        description = 'Process has been stopped. Check and fix the issue.';
        break;

    }
    slackUrlRouter.addMessage({
      name: parseProcessName(data.process),
      event: data.event,
      description: description,
      interactive: interactive,
      timestamp: Math.floor(Date.now() / 1000),
    });
  });
});

if (process.env["SLACK_SIGNING_SECRET"] && process.env["SLACK_BOT_TOKEN"] && process.env["SLACK_PORT"]) {
  (async () => {

    await app.start();

    console.log(`Slack bot is ready. Listening on ${process.env["SLACK_PORT"]} port.`);
  })();
}

/**
 * @typedef {Object} Message
 *
 * @property {string} name - Process name
 * @property {string} event - `start`|`stop`|`restart`|`error`|`exception`|`restart overlimit`| ...
 * @property {string} description
 * @property {number} timestamp - Linux timestamp format
 */