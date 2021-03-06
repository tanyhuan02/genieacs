/**
 * Copyright 2013-2016  Zaid Abdulla
 *
 * GenieACS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * GenieACS is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with GenieACS.  If not, see <http://www.gnu.org/licenses/>.
 */
"use strict";

const vm = require("vm");

const common = require("./common");
const device = require("./device");
const extensions = require("./extensions");


// Used for throwing to exit user script and commit
const COMMIT = Symbol();

// Used to execute extensions and restart
const EXT = Symbol();

const sandbox = {
  timestamp: null,
  deviceData: null,
  revision: null,
  maxRevision: null,
  uncommitted: false,
  declarations: null,
  extensionsCache: null,
  extensions: null,
  context: vm.createContext()
}

class SandboxDate {
  constructor(arg) {
    if (arguments.length)
      return new (Function.prototype.bind.apply(Date, arguments));

    return new Date(sandbox.timestamp);
  }

  static now() {
    return sandbox.timestamp;
  }
};


class ParameterWrapper {
  constructor(path, attributes, unpacked, unpackedRevision) {
    for (let attrName of attributes) {
      Object.defineProperty(this, attrName, {get: function() {
        if (sandbox.uncommitted)
          commit();

        if (sandbox.revision !== unpackedRevision) {
          unpackedRevision = sandbox.revision;
          unpacked = device.unpack(sandbox.deviceData, path, sandbox.revision + 1);
        }

        if (!unpacked.length)
          return undefined;

        let attr = sandbox.deviceData.attributes.get(unpacked[0], sandbox.revision + 1)[attrName];

        if (!attr)
          return undefined;

        return attr[1];
      }});
    }

    Object.defineProperty(this, "path", {get: function() {
      if (sandbox.uncommitted)
        commit();

      if (sandbox.revision !== unpackedRevision) {
        unpackedRevision = sandbox.revision;
        unpacked = device.unpack(sandbox.deviceData, path, sandbox.revision + 1);
      }

      if (!unpacked.length)
        return undefined;

      return unpacked[0].join('.');
    }});

    Object.defineProperty(this, "size", {get: function() {
      if (sandbox.uncommitted)
        commit();

      if (sandbox.revision !== unpackedRevision) {
        unpackedRevision = sandbox.revision;
        unpacked = device.unpack(sandbox.deviceData, path, sandbox.revision + 1);
      }

      if (!unpacked.length)
        return undefined;

      return unpacked.length;
    }});

    this[Symbol.iterator] = function*() {
      if (sandbox.uncommitted)
        commit();

      if (sandbox.revision !== unpackedRevision) {
        unpackedRevision = sandbox.revision;
        unpacked = device.unpack(sandbox.deviceData, path, sandbox.revision + 1);
      }

      for (let p of unpacked)
        yield new ParameterWrapper(p, attributes, [p], sandbox.revision);
    }
  }
}


function declare(path, timestamps, values) {
  sandbox.uncommitted = true;
  if (!timestamps)
    timestamps = {};

  let parsedPath = common.parsePath(path);

  sandbox.declarations[path] = sandbox.declarations[path] || [parsedPath, 1, {}, null, {}];

  let attrs = {};
  for (let attrName in timestamps) {
    if (attrName === "path") {
      if (timestamps.path > sandbox.declarations[path][1])
        sandbox.declarations[path][1] = timestamps.path;
    }
    else {
      attrs[attrName] = 1;
      if (!(timestamps[attrName] <= sandbox.declarations[path][2][attrName]))
        sandbox.declarations[path][2][attrName] = timestamps[attrName];
    }
  }

  if (values) {
    for (let attrName in values) {
      if (attrName === "path")
        sandbox.declarations[path][3] = values.path;
      else {
        attrs[attrName] = 1;
        if (attrName === 'value' && !Array.isArray(values[attrName]))
          sandbox.declarations[path][4].value = [values[attrName]];
        else
          sandbox.declarations[path][4].value = values[attrName];
      }
    }
  }

  return new ParameterWrapper(parsedPath, Object.keys(attrs));
}


function clear(path, timestamp, attributes) {
  sandbox.uncommitted = true;

  if (sandbox.revision === sandbox.maxRevision) {
    sandbox.clear = sandbox.clear || [];
    sandbox.clear.push([common.parsePath(path), timestamp, attributes]);
  }
}


function commit() {
  ++ sandbox.revision;
  sandbox.uncommitted = false;

  if (sandbox.revision === sandbox.maxRevision + 1)
    throw COMMIT;
  else if (sandbox.revision > sandbox.maxRevision + 1)
    throw new Error("Declare function should not be called from within a try/catch block");
}


function ext() {
  let extCall = Array.from(arguments).map(String);
  let key = `${sandbox.revision}: ${JSON.stringify(extCall)}`;

  if (key in sandbox.extensionsCache)
    return sandbox.extensionsCache[key];

  sandbox.extensions[key] = extCall;
  throw EXT;
}


Object.defineProperty(sandbox.context, 'Date', {value: SandboxDate});
Object.defineProperty(sandbox.context, 'declare', {value: declare});
Object.defineProperty(sandbox.context, 'clear', {value: clear});
Object.defineProperty(sandbox.context, 'commit', {value: commit});
Object.defineProperty(sandbox.context, 'ext', {value: ext});


function run(script, globals, timestamp, deviceData, extensionsCache, startRevision, maxRevision, callback) {
  sandbox.timestamp = timestamp;
  sandbox.deviceData = deviceData;
  sandbox.extensionsCache = extensionsCache;
  sandbox.revision = startRevision;
  sandbox.maxRevision = maxRevision;
  sandbox.uncommitted = false;
  sandbox.declarations = {};
  sandbox.extensions = {};
  sandbox.clear = null;

  for (let n in sandbox.context)
    delete sandbox.context[n];

  for (let n in globals)
    sandbox.context[n] = globals[n];

  try {
    let ret = script.runInContext(sandbox.context, {displayErrors: false});

    let declarations = [];
    for (let p in sandbox.declarations)
      declarations.push(sandbox.declarations[p]);

    let counter = 1;
    for (let key in sandbox.extensions) {
      ++ counter;
      extensions.run(sandbox.extensions[key], function(err, res) {
        sandbox.extensionsCache[key] = res;
        if (-- counter === 0)
          return callback(null, sandbox.clear, declarations, true, ret);
      });
    }
    if (-- counter === 0)
      return callback(null, sandbox.clear, declarations, true, ret);
  }
  catch (err) {
    if (err === COMMIT) {
      let declarations = [];
      for (let p in sandbox.declarations)
        declarations.push(sandbox.declarations[p]);

      let counter = 1;
      for (let key in sandbox.extensions) {
        ++ counter;
        extensions.run(sandbox.extensions[key], function(err, res) {
          sandbox.extensionsCache[key] = res;
          if (-- counter === 0)
            return callback(null, sandbox.clear, declarations, false);
        });
      }
      if (-- counter === 0)
        return callback(null, sandbox.clear, declarations, false);
    }
    else if (err === EXT) {
      let counter = 1;
      for (let key in sandbox.extensions) {
        ++ counter;
        extensions.run(sandbox.extensions[key], function(err, res) {
          sandbox.extensionsCache[key] = res;
          if (-- counter === 0)
            return run(script, globals, timestamp, deviceData, extensionsCache, startRevision, maxRevision, callback);
        });
      }
      if (-- counter === 0)
        return run(script, globals, timestamp, deviceData, extensionsCache, startRevision, maxRevision, callback);
    }
    else
      return callback(err);
  }
}


exports.run = run;
