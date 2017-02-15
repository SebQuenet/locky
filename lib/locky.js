/**
 * Module dependencies.
 */

var events = require('events');
var util = require('util');
var _ = require('lodash');
var redis = require('then-redis');
var Promise = require('bluebird');
var pipeEvent = require('pipe-event');
var resourceKey = require('./resource-key');

/**
 * Expose module.
 */

module.exports = Locky;

/**
 * Create a new Locky client.
 *
 * @param {object} options
 * @param {function|object} options.redis
 * @param {number} options.ttl
 */

function Locky(options) {
  var locky = this;

  options = _.defaults(options || {}, {
    ttl: null,
    redis: {}
  });

  locky.ttl = options.ttl;
  locky.redis = locky._createRedisClient(options.redis);

  pipeEvent(['error'], locky.redis, this);

  locky._resourceTimeouts = {};

  events.EventEmitter.call(locky);
}

/**
 * Inherits from EventEmitter.
 */

util.inherits(Locky, events.EventEmitter);

/**
 * Try to lock a resource using a locker identifier.
 *
 * @param {object} options
 * @param {string|number} options.resource Resource identifier to lock
 * @param {string|number} options.locker Locker identifier
 * @param {boolean} options.force Force gaining lock even if it's taken
 * @param {Promise} [callback] Optional callback
 */

Locky.prototype.lock = function (options, callback) {
  var locky = this;

  options = options || {};

  // Format key with resource id.
  var key = resourceKey.format(options.resource);

  // Define the method to use.
  var method = options.force ? 'set' : 'setnx';

  // Set the lock key.
  return locky.redis[method](key, options.locker)
  .then(function (res) {
    var success = res === 1 || res === 'OK';

    if (!locky.ttl || !success) return success;

    return locky.redis.pexpire(key, locky.ttl)
    .then(function () {
      locky._listenExpiration(options.resource);
      return success;
    });
  })
  .then(function (success) {
    if (success)
      locky.emit('lock', options.resource, options.locker);
    return success;
  })
  .nodeify(callback);
};

/**
 * Refresh the lock ttl of a resource.
 *
 * @param {string} resource Resource
 * @param {function} [callback] Optional callback
 */

Locky.prototype.refresh = function (resource, callback) {
  var locky = this;

  return new Promise(function (resolve, reject) {
    // If there is no TTL, do nothing.
    if (!locky.ttl) return resolve();

    // Format key with resource id.
    var key = resourceKey.format(resource);

    // Set the TTL of the key.
    locky.redis.pexpire(key, locky.ttl).then(resolve, reject);
  })
  .then(function () {
    locky._listenExpiration(resource);
  })
  .nodeify(callback);
};

/**
 * Unlock a resource.
 *
 * @param {string} resource Resource
 * @param {function} [callback] Optional callback
 */

Locky.prototype.unlock = function (resource, callback) {
  var locky = this;

  // Format key with resource id.
  var key = resourceKey.format(resource);

  // Remove the key.
  return locky.redis.del(key)
  .then(function (res) {
    if (res === 0) return;

    locky.emit('unlock', resource);
    locky._clearExpiration(resource);
  })
  .nodeify(callback);
};

/**
 * Return the resource locker.
 *
 * @param {string} resource Resource
 * @param {function} [callback] Optional callback
 */

Locky.prototype.getLocker = function (resource, callback) {
  return this.redis.get(resourceKey.format(resource)).nodeify(callback);
};

/**
 * Return the locked resources.
 *
 * @param {function} [callback] Optional callback
 */

Locky.prototype.getLockedResources = function (callback) {
  return this.redis.keys(resourceKey.format('*'))
  .then(function (lockedResources) {
    return lockedResources.map(resourceKey.parse);
  })
  .nodeify(callback);
};

/**
 * Close the client.
 *
 * @param {function} [callback] Optional callback
 */

Locky.prototype.close = function (callback) {
  return this.redis.quit().nodeify(callback);
};

/**
 * Listen expiration.
 *
 * @param {string} resource Resource
 */

Locky.prototype._listenExpiration = function (resource) {
  var bindedExpire = this._onExpire.bind(this, resource);
  this._resourceTimeouts[resource] = setTimeout(bindedExpire, this.ttl);
};

/**
 * Clear timeout on expiration.
 *
 * @param {string} resource Resource
 */

Locky.prototype._clearExpiration = function (resource) {
  var timeout = this._resourceTimeouts[resource];

  if (timeout)
    clearTimeout(timeout);
};

/**
 * Called when a lock expire.
 *
 * @param {string} resource
 */

Locky.prototype._onExpire = function (resource) {
  var locky = this;

  return locky.getLocker(resource).then(function (locker) {
    // If there is a locker, the key has not expired.
    if (locker) return;

    // Emit an expire event.
    locky.emit('expire', resource);
  });
};

/**
 * Create the redis client.
 *
 * @param {object|function} options
 */

Locky.prototype._createRedisClient = function (options) {
  if (_.isFunction(options)) return options();

  return redis.createClient(options);
};
