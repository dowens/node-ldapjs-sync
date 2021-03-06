/**
 * Copyright 2012 Yunong Xiao, Inc. All rights reserved.
 *
 * The set of handlers that are specific to ldap delete replication.
 * All handlers adhere to the API f(changelog, replicator, next)
 * where changelog is the replicated ldap changelog object, replicator is
 * the ReplContext object, and next is next handler in the chain. Al handlers
 * process.exit(1) on error.
 */


var common = require('./common');

function localSearch(changelog, replicator, next) {
  var log = replicator.log;
  log.debug('entering localsearch with %j', changelog.object);
  var targetDn = changelog.localDn;

  var localClient = replicator.localClient;
  replicator.localPool.acquire(function(err, localClient) {
    if (err) {
      self.log.fatal('unable to acquire client from pool', err);
      process.exit(1);
    }

    localClient.search(targetDn, { scope: 'base' }, function(err, res) {
      if (err) {
        log.error('localsearch unable to search', err);
        process.exit(1);
      }

      res.on('searchEntry', function(entry) {
        log.debug('got local search entry %j', entry.object);
        changelog.localEntry = entry;
      });

      res.on('error', function(err) {
        // no such object error
        if (err.code === 32) {
          log.debug('%j does not exist locally, exiting', changelog.object);
          // skip right to writing the checkpoint
          return common.writeCheckpoint(changelog, replicator, function() {
            replicator.localPool.release(localClient);
            return next(true);
          });
        }
        log.error('error while local searching', err);
        process.exit(1);
      });

      res.on('end', function(res) {
        // check that the filter matched too, if the filter does not match,
        // end gets called but no entry is found.
        if (!changelog.localEntry) {
          // if there are no local entries, that means the DN exists but the
          // filter (objectclass=*)) does not match, so we throw as all objects
          // need objectclass=*
          log.fatal('%j exists but does not match filter objectclass=*',
                    changelog.object);
          process.exit(1);
        } else {
          log.debug('successfully exiting local search entry');
          replicator.localPool.release(localClient);
          return next();
        }
      });
    });
  });
}

function determineDelete(changelog, replicator, next) {
  var log = replicator.log;
  //var log = replicator.log4js.getLogger('delete.js');
  log.debug('entering delete determineDelete with remote %j, local %j',
            changelog.object, changelog.localEntry.object);
  /*
   * There are 2 scenarios
   * 1) The local entry matches the replication filter.
   * 2) The local entry doesn't match the replication filter.
   *
   * Only 1) will be deleted.
   * Not worrying about DN here as localSearch already determined the DN
   * matches
   */

  var filter = replicator.remoteUrl.filter;
  var localEntry = changelog.localEntry;

  if (filter.matches(localEntry.object)) {
    log.debug('entry %j matches, deleting entry', localEntry.object);
    replicator.localPool.acquire(function(err, localClient) {
      if (err) {
        self.log.fatal('unable to acquire client from pool', err);
        process.exit(1);
      }
      localClient.del(localEntry.dn, function(err) {
        //TODO: Recursive delete locally?
        if (err) {
          log.error('unable to delete %j', localEntry, err);
          process.exit(1);
        }
        log.debug('local entry %j and exiting', localEntry.object);
        replicator.localPool.release(localClient);
        return next();
      });
    });
  } else {
    log.debug('localentry %j doesnt match filter %j exiting but not deleting',
              localEntry.object, filter);
    return next();
  }
}

///--- API

module.exports = {
  chain: function(handlers) {
    if (!handlers) {
      handlers = [];
    }

    // handlers for delete
    [
      // Check checkpoint
      common.getCheckpoint,
      // Convert the targetDn to the localDn
      common.convertDn,
      // Search locally for entry with replication filter
      localSearch,
      // Determine from search results and possibly delete the entry
      determineDelete,
      // Write the new checkpoint
      common.writeCheckpoint
    ].forEach(function(h) {
      handlers.push(h);
    });

    return handlers;
  },
  // for unit tests
  localSearch: localSearch,
  determineDelete: determineDelete
};