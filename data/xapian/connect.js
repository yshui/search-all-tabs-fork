/* global UTF8ToString */
'use strict';

const xapian = {
  name: 'object-storage-xapian'
};

// eslint-disable-next-line no-var
var Module = {};

Module['onRuntimeInitialized'] = () => {
  const _add = Module.cwrap('add', null,
    ['number', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string']
  );
  const _commit = Module.cwrap('commit', null, ['number']);
  const _query = Module.cwrap('query', null, ['number', 'string', 'string', 'number', 'number', 'boolean', 'boolean', 'boolean', 'boolean']);
  const _prepare = Module.cwrap('prepare', null, ['number', 'string']);
  const _release = Module.cwrap('release', null, ['number']);
  const _key = Module.cwrap('key', 'number', ['number']);
  const _snippet = Module.cwrap('snippet', 'string', ['string', 'string', 'number', 'string']);
  const _percent = Module.cwrap('percent', 'number', ['number']);
  const _clean = Module.cwrap('clean', null, ['number', 'string']);
  const toString = ptr => UTF8ToString(ptr); // eslint-disable-line new-cap
  // add a new database
  xapian.new = (index, name) => {
    _prepare(index, name);
  };

  xapian.release = index => {
    _release(index);
  };

  xapian.remove = (guid, db = 0) => {
    _clean(db, guid + '');
  }

  xapian.commit = async (index = 0) => {
    _commit(index);
    await (new Promise((resolve, reject) => FS.syncfs(err => {
      if (err) reject(err);
      else resolve();
    })));
  }

  xapian.add = ({
    mime = '',
    keywords = '',
    date = '',
    description = '',
    lang = 'english',
    url,
    title,
    body,
    timestamp
  }, hidden = {}, guid, db = 0) => new Promise((resolve, reject) => {
    const {hostname, pathname} = url ? new URL(url) : {
      hostname: '',
      pathname: ''
    };

    const filename = pathname;

    keywords = keywords.split(/\s*,\s*/).join(',');

    const object = Object.assign({mime, url, hostname, title, body}, hidden, {
      timestamp: Date.now() || timestamp
    });
    if (guid) {
      object.guid = guid;
    }
    const next = guid => {
      try {
        _add(db, guid + '', lang, hostname, url, date, filename, mime, title, keywords, description, body);
        resolve(guid + '');
      }
      catch (e) {
        console.error(e);
        reject(e);
      }
    };
    const request = xapian.storage.transaction(['objects'], 'readwrite')
      .objectStore('objects').put(object);
    request.onsuccess = () => {
      next(request.result);
    };
    request.onerror = reject;
  });

  xapian.search = ({query, start = 0, length = 30, lang = 'english', partial = true, spell_correction = false, synonym = false, descending = true}, db = 0) => {
    const pointer = _query(
      db, lang, query, start, length, partial, spell_correction, synonym, descending
    );
    const rst = toString(pointer);
    if (rst.startsWith('Error: ')) {
      throw Error(rst.replace('Error: ', ''));
    }
    const [size, estimated] = rst.split('/');
    return {
      size: Number(size),
      estimated: Number(estimated)
    };
  };
  xapian.search.guid = index => {
    return toString(_key(index));
  };
  // get body of "index"ed matching result
  xapian.search.body = index => {
    const guid = xapian.search.guid(index);
    return xapian.body(guid);
  };
  // get snippet based on the actual content of the "index"ed matching result
  // if body is not stored, content is mandatory
  xapian.search.snippet = ({index, lang = 'english', omit = '', content, size = 300}) => {
    if (content) {
      return Promise.resolve(_snippet(lang, content, size, omit));
    }
    const guid = xapian.search.guid(index);
    return xapian.body(guid).then(obj => _snippet(lang, obj.body, size, omit));
  };
  // get weight percent of "index"ed matching result
  xapian.search.percent = index => {
    return _percent(index);
  };


  xapian.body = guid => new Promise((resolve, reject) => {
    // if guid is auto generated, it is a number, though xapian storage returns string
    // we need to convert to search the IndexedDB database
    if (isNaN(guid) === false) {
      guid = Number(guid);
    }
    const request = xapian.storage.transaction(['objects'], 'readonly')
      .objectStore('objects')
      .openCursor(IDBKeyRange.only(guid));
    request.onsuccess = e => e.target.result ? resolve(e.target.result.value) : reject(Error('no result'));
    request.onerror = reject;
  });

  FS.mkdir('/idb');
  FS.mount(IDBFS, {}, '/idb');

  FS.syncfs(true, function(err) {
    if (err) throw err;
    xapian.new(0, '/idb/database');
    // object storage
    const request = indexedDB.open(xapian.name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;

      // Delete the old database if it exists
      if (db.objectStoreNames.contains('objects')) {
        db.deleteObjectStore('oldObjectStore');
      }
      // create new storage
      const store = db.createObjectStore('objects', {
        keyPath: 'guid',
        autoIncrement: true
      });
      store.createIndex('guid', 'guid', {
        unique: true
      });
      store.createIndex('timestamp', 'timestamp', {
        unique: false
      });
      store.createIndex('pinned', 'pinned', {
        unique: false
      });
    };
    request.onerror = e => console.error(e);
    request.onsuccess = () => {
      xapian.storage = request.result;
      document.dispatchEvent(new Event('engine-ready'));
    };
  });
};

xapian.language = code => {
  code = code.split('-')[0];

  return ({
    'ar': 'arabic',
    'fa': 'arabic',
    'hy': 'armenian',
    'eu': 'basque',
    'ca': 'catalan',
    'da': 'danish',
    'nl': 'dutch',
    'en': 'english',
    'fi': 'finnish',
    'fr': 'french',
    'de': 'german',
    'hu': 'hungarian',
    'id': 'indonesian',
    'ga': 'irish',
    'it': 'italian',
    'lt': 'lithuanian',
    'ne': 'nepali',
    'no': 'norwegian',
    'nn': 'norwegian',
    'nb': 'norwegian',
    'pt': 'portuguese',
    'ro': 'romanian',
    'ru': 'russian',
    'es': 'spanish',
    'sv': 'swedish',
    'ta': 'tamil',
    'tr': 'turkish'
  })[code] || 'english';
};

{
  const add = src => new Promise(resolve => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    document.body.appendChild(s);
  });
  window.engine = xapian;
  add('/data/xapian/xapian_noexception_wasm_db.js');
}
