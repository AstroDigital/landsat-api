// USGS Landsat Imagery Metadata RES API
//
// Forked from https://github.com/FDA/openfda/tree/master/api
// Exposes /landsat/metadata.json and /healthcheck GET endpoints
//
// Author: developmentseed
// Contributer: scisco
//
// License: CC0 1.0 Universal

var join = require('path').join;
var fse = require('fs-extra');
var env = require('node-env-file');

// Read and load env variables from .env FILE if it exists
var envFile = join(__dirname, '.env');

if (fse.existsSync(envFile)) {
  try {
    env(__dirname + '/.env');
  }
  catch(err) {
    console.log(err);
  }
}

var PROVIDED_BY = process.env.PROVIDED_BY || 'Development Seed'

// New Relic monitoring
require('newrelic');
var ejs = require('elastic.js');
var elasticsearch = require('elasticsearch');
var express = require('express');
var moment = require('moment');
var _ = require('underscore');
var inside = require('turf-inside');
var point = require('turf-point');
var polygon = require('turf-polygon');

var api_request = require('./api_request.js');
var elasticsearch_query = require('./elasticsearch_query.js');
var logging = require('./logging.js');
var META = {
  'credit': 'Astro Digital',
  'website': 'https://api.astrodigital.com/v1',
  'license': 'http://creativecommons.org/publicdomain/zero/1.0/legalcode',
};

var HTTP_CODE = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  SERVER_ERROR: 500
};

// Internal fields to remove from ES objects before serving
// via the API.
var FIELDS_TO_REMOVE = [

];

var MAIN_INDEX = 'landsat';

var app = express();

var containsPattern = /(\sAND\s)?contains:(-?\d+(?:\.\d*)?,-?\d+(?:\.\d*)?)/;

app.disable('x-powered-by');

// Set caching headers for Amazon Cloudfront
CacheMiddleware = function(seconds) {
  return function(request, response, next) {
    response.setHeader('Cache-Control', 'public, max-age=' + seconds);
    return next();
  };
};
app.use(CacheMiddleware(60));

// Use gzip compression
app.use(express.compress());

// Setup defaults for API JSON error responses
app.set('json spaces', 2);
app.set('json replacer', undefined);

var log = logging.GetLogger();

var client = new elasticsearch.Client({
  host: process.env.ES_HOST || 'localhost:9200',
  log: logging.ElasticsearchLogger,

  // Note that this doesn't abort the query.
  requestTimeout: 10000  // milliseconds
});

app.get('/healthcheck', function(request, response) {
  client.cluster.health({
    index: MAIN_INDEX,
    timeout: 1000 * 60,
    waitForStatus: 'yellow'
  }, function(error, health_response, status) {
    health_json = JSON.stringify(health_response, undefined, 2);
    if (error != undefined) {
      response.send(500, 'NAK.\n' + error + '\n');
    } else if (health_response['status'] == 'red') {
      response.send(500, 'NAK.\nStatus: ' + health_json + '\n');
    } else {
      response.send('OK\n\n' + health_json + '\n');
    }
  });
});

ApiError = function(response, code, message) {
  error_response = {};
  error_response.error = {};
  error_response.error.code = code;
  error_response.error.message = message;
  response.json(HTTP_CODE[code], error_response);
};

LogRequest = function(request) {
  log.info(request.headers, 'Request Headers');
  log.info(request.query, 'Request Query');
};

SetHeaders = function(response) {
  response.header('Server', process.env.RESPONSE_HEADER_SERVER || 'api.developmentseed.org');
  // http://john.sh/blog/2011/6/30/cross-domain-ajax-expressjs-
  // and-access-control-allow-origin.html
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'X-Requested-With');
  response.header('Content-Security-Policy', "default-src 'none'");
  // https://www.owasp.org/index.php/REST_Security_Cheat_Sheet
  // #Send_security_headers
  response.header('X-Content-Type-Options', 'nosniff');
  response.header('X-Frame-Options', 'deny');
  response.header('X-XSS-Protection', '1; mode=block');
};

TryToCheckApiParams = function(request, response) {
  try {
    return api_request.CheckParams(request.query);
  } catch (e) {
    log.error(e);
    if (e.name == api_request.API_REQUEST_ERROR) {
      ApiError(response, 'BAD_REQUEST', e.message);
    } else {
      ApiError(response, 'BAD_REQUEST', '');
    }
    return null;
  }
};

TryToBuildElasticsearchParams = function(params, elasticsearch_index, response) {

  try {
    var es_query = elasticsearch_query.BuildQuery(params);
    log.info(es_query.toString(), 'Elasticsearch Query');
  } catch (e) {
    log.error(e);
    if (e.name == elasticsearch_query.ELASTICSEARCH_QUERY_ERROR) {
      ApiError(response, 'BAD_REQUEST', e.message);
    } else {
      ApiError(response, 'BAD_REQUEST', '');
    }
    return null;
  }

  var es_search_params = {
    index: elasticsearch_index,
    body: es_query.toString()
  };

  if (!params.count) {
    es_search_params.from = params.skip;
    es_search_params.size = params.limit;
  }

  return es_search_params;
};

TrySearch = function(index, params, es_search_params, response, cLonLat) {
  client.search(es_search_params).then(function(body) {
    if (body.hits.hits.length == 0) {
      ApiError(response, 'NOT_FOUND', 'No matches found!');
    }

    var response_json = {};
    response_json.meta = _.clone(META);

    if (!params.count) {
      response_json.meta.results = {
        'skip': params.skip,
        'limit': params.limit,
        'total': body.hits.total
      };

      response_json.results = [];
      for (i = 0; i < body.hits.hits.length; i++) {
        var es_results = body.hits.hits[i]._source;
        for (j = 0; j < FIELDS_TO_REMOVE.length; j++) {
          delete es_results[FIELDS_TO_REMOVE[j]];
        }
        response_json.results.push(es_results);
      }
      response.json(HTTP_CODE.OK, responseFilter(response_json, cLonLat, params.userLimit));

    } else if (params.count) {
      if (body.facets.count.terms) {
        // Term facet count
        if (body.facets.count.terms.length != 0) {
          response_json.results = body.facets.count.terms;
          response.json(HTTP_CODE.OK, responseFilter(response_json, cLonLat, params.userLimit));
        } else {
          ApiError(response, 'NOT_FOUND', 'Nothing to count');
        }
      } else if (body.facets.count.entries) {
        // Date facet count
        if (body.facets.count.entries.length != 0) {
          for (i = 0; i < body.facets.count.entries.length; i++) {
            var day = moment(body.facets.count.entries[i].time);
            body.facets.count.entries[i].time = day.format('YYYYMMDD');
          }
          response_json.results = body.facets.count.entries;
          response.json(HTTP_CODE.OK, responseFilter(response_json, cLonLat, params.userLimit));
        } else {
          ApiError(response, 'NOT_FOUND', 'Nothing to count');
        }
      } else {
        ApiError(response, 'NOT_FOUND', 'Nothing to count');
      }
    } else {
      ApiError(response, 'NOT_FOUND', 'No matches found!');
    }
  }, function(error) {
    log.error(error);
    ApiError(response, 'SERVER_ERROR', 'Check your request and try again');
  });
};

Endpoint = function(noun) {
  app.get('/' + noun, function(request, response) {
    LogRequest(request);
    SetHeaders(response);

    var params = TryToCheckApiParams(request, response);
    if (params == null) {
      return;
    }

    var index = noun;

    // remove contains clause for use in turf
    // add a search parameter to limit the extent
    var cLonLat;
    if (containsPattern.test(params.search)) {
      contains = params.search.match(containsPattern)[2];
      cLonLat = contains.split(',');
      // because we are filtering after the elasticsearch query, limit our results to the extent
      // but allow unlimited results
      params.search = params.search.replace(containsPattern,'$1upperLeftCornerLatitude:[' +
        cLonLat[1] + ' TO 1000] AND lowerRightCornerLatitude:[-1000 TO ' +
        cLonLat[1] + '] AND lowerLeftCornerLongitude:[-1000 TO ' +
        cLonLat[0] + '] AND upperRightCornerLongitude:[' +
        cLonLat[0] + ' TO 1000]');
      // need to return all results internally but retain the user selected limit
      params.userLimit = _.clone(params.limit)
      params.limit = process.env.QUERY_LIMIT || 1000000000;
    }

    var es_search_params =
      TryToBuildElasticsearchParams(params, index, response);
    if (es_search_params == null) {
      return;
    }

    TrySearch(index, params, es_search_params, response, cLonLat);
  });
};

  /**
   * This returns the response_json optionally filtered for scenes containing a given point.
   * @param {object} response_json the api response object
   * @param {array} cLonLat an array containing a longitude and latitude for filtering
   * @param {number} limit user provided value for number of results to return
   * @returns {object} the reponse_json with the results property filtered by cLonLat.
   */

responseFilter = function (response_json, cLonLat, limit) {
  if (!cLonLat) return response_json;
  var thePoint = point(cLonLat);
  var resultPolygon;
  response_json.results = response_json.results.filter(function(result){
    resultPolygon = polygon([[
      [result.lowerLeftCornerLongitude, result.lowerLeftCornerLatitude],
      [result.upperLeftCornerLongitude, result.upperLeftCornerLatitude],
      [result.upperRightCornerLongitude, result.upperRightCornerLatitude],
      [result.lowerRightCornerLongitude, result.lowerRightCornerLatitude],
      [result.lowerLeftCornerLongitude, result.lowerLeftCornerLatitude]
    ]]);
    return inside(thePoint, resultPolygon);
  })

  // overwrite the metadata to show the user selected limit
  // slice the response accordingly
  response_json.meta.results.limit = limit
  response_json.meta.results.total = response_json.results.length
  response_json.results = response_json.results.slice(0,limit)

  return response_json;
}

Endpoint('landsat');

// From http://strongloop.com/strongblog/
// robust-node-applications-error-handling/
if (process.env.NODE_ENV === 'production') {
  process.on('uncaughtException', function(e) {
    log.error(e);
    process.exit(1);
  });
}

var port = process.env.PORT || 8000;
app.listen(port, function() {
  console.log('Listening on ' + port);
});
