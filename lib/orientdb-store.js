/*jslint node: true*/
/*jslint asi: true */
/* Copyright (c) 2012-2013 Marian Radulescu */
"use strict";

var _ = require('underscore');
var OrientDB = require('orientjs');
var util = require('util')
var uuid = require('node-uuid');
var relationalstore = require('./relational-util')

var name = 'orientdb-store';

var MIN_WAIT = 16
var MAX_WAIT = 5000

module.exports = function (opts) {

    var seneca = this;
    var _server = null;
    var _db = null;

    opts.minwait = opts.minwait || MIN_WAIT
    opts.maxwait = opts.maxwait || MAX_WAIT

    var minwait
    var dbinst = null

    var upperCaseRegExp = /[A-Z]/g

    function camelToSnakeCase(field) {
        // replace "camelCase" with "camel_case"
        upperCaseRegExp.lastIndex = 0 // just to be sure. does not seem necessay. String.replace seems to reset the regexp each time.
        return field.replace(upperCaseRegExp, function (str, offset) {
            return ('_' + str.toLowerCase());
        })
    }

    function snakeToCamelCase(column) {
        // replace "snake_case" with "snakeCase"
        var arr = column.split('_')
        var field = arr[0]
        for (var i = 1; i < arr.length; i++) {
            field += arr[i][0].toUpperCase() + arr[i].slice(1, arr[i].length)
        }

        return field
    }

    function transformDBRowToJSObject(row) {
        var obj = {}
        for (var attr in row) {
            if (row.hasOwnProperty(attr)) {
                obj[snakeToCamelCase(attr)] = row[attr]
            }
        }
        return obj
    }

    function error(query, args, err, cb) {
        if (err) {
            var errorDetails = {
                message: err.message,
                err: err,
                stack: err.stack,
                query: query
            }
            seneca.log.error('Query Failed', JSON.stringify(errorDetails, null, 1))
            seneca.fail({code: 'entity/error', store: name}, cb)

            if ('ECONNREFUSED' == err.code || 'notConnected' == err.message || 'Error: no open connections' == err) {
                minwait = opts.minwait
                if (minwait) {
                    reconnect(args)
                }
            }

            return true
        }

        return false
    }


    function reconnect(args) {
        seneca.log.debug('attempting db reconnect')

        configure(opts, function (err) {
            if (err) {
                seneca.log.debug('db reconnect (wait ' + opts.minwait + 'ms) failed: ' + err)
                minwait = Math.min(2 * minwait, opts.maxwait)
                setTimeout(function () {
                    reconnect(args)
                }, minwait)
            } else {
                minwait = opts.minwait
                seneca.log.debug('reconnect ok')
            }
        })
    }

    var pgConf;

    function configure(spec, cb) {

        pgConf = 'string' === typeof(spec) ? null : spec

        if (!pgConf) {
            pgConf = {}

            var urlM = /^orientdb:\/\/((.*?):(.*?)@)?(.*?)(:?(\d+))?\/(.*?)$/.exec(spec);
            pgConf.name = urlM[7]
            pgConf.port = urlM[6]
            pgConf.host = urlM[4]
            pgConf.username = urlM[2]
            pgConf.password = urlM[3]

            pgConf.port = pgConf.port ? parseInt(pgConf.port, 10) : null
        }

        // pg conf properties
        pgConf.user = pgConf.username
        pgConf.database = pgConf.name

        pgConf.host = pgConf.host || pgConf.server
        pgConf.username = pgConf.username || pgConf.user
        pgConf.password = pgConf.password || pgConf.pass

        pgConf.dbuser = pgConf.dbuser
        pgConf.dbpass = pgConf.dbpass

        if (_server == null) {
            _server = new OrientDB({
                host: pgConf.host,
                port: pgConf.port,
                username: pgConf.username,
                password: pgConf.password
            })
        }
        if (_db == null) {
            _db = _server.use({
                name: pgConf.name,
                username: pgConf.dbuser,
                password: pgConf.dbpass
            })
        }

        setImmediate(function () {
            cb(undefined)
        })
    }

    function execQuery(query, callback) {

        if (!query) {
            var err = new Error('Query cannot be empty')
            seneca.log.error('An empty query is not a valid query', err)
            return callback(err)
        }

        if (query.values) {
            _db.query(query.text, {
                params: query.values
            }).then(function (rows) {
                return callback(null, {rows: rows});
            })
        } else {
            _db.query(query.text).then(function (rows) {
                return callback(null, {rows: rows});
            })
        }
    }

    var store = {

        name: name,

        close: function (args, cb) {
            _server.close();
            setImmediate(cb)
        },


        save: function (args, cb) {
            var ent = args.ent
            var query;
            var update = !!ent.id;

            if (update) {
                query = updatestm(ent)
                _db.update(query.table).set(query.entp).where({'@rid': query.rid}).scalar().then(function (total) {
                    cb(null, {updated: total})
                })
                //seneca.fail({code: 'update', tag: args.tag$, store: store.name, query: query, error: err}, cb)
            }
            else {

                query = savestm(ent)
                _db.insert().into(query.table).set(query.entp).one().then(function (record) {
                    var entq = relationalstore.makeent(ent, record)
                    seneca.log(args.tag$, 'save', entq)
                    return cb(null, entq)
                })
            }
        },


        load: function (args, cb) {
            var qent = args.qent
            var q = args.q

            var query = selectstm(qent, q)
            var trace = new Error()
            execQuery(query, function (err, res) {
                if (!error(query, args, err, cb)) {
                    var ent = null
                    if (res.rows && res.rows.length > 0) {
                        var attrs = transformDBRowToJSObject(res.rows[0])
                        ent = relationalstore.makeent(qent, attrs)
                    }
                    seneca.log(args.tag$, 'load', ent)
                    return cb(null, ent)
                }
                else {
                    seneca.log.error(query.text, query.values, trace.stack)
                    seneca.fail({code: 'load', tag: args.tag$, store: store.name, query: query, error: err}, cb)
                }
            })
        },


        list: function (args, cb) {
            var qent = args.qent
            var q = args.q

            var list = []

            var query

            if (q.distinct$) {
                query = distinctStatement(qent, q)
            } else if (q.ids) {
                query = selectstmOr(qent, q)
            } else if (typeof(q) == "string" || q.length != undefined) {
                if (typeof(q) == "string") {
                    q = [q];
                }

                var text = q[0];
                var newText = '';
                var qq = {};
                var cnt = 0;

                for (var qp in text) {
                    if (text[qp] == '?') {
                        var paramName = "param" + (cnt++);
                        newText += ":" + paramName;
                        qq[paramName] = q[cnt];
                    } else {
                        newText += text[qp];
                    }
                }

                query = {text: newText, values: qq}
            } else {
                query = selectstm(qent, q)
            }

            /**
             * query: {text: "select * from foo where p1=:p1 AND v2=:v2", values: {p1: "aa", v2: "bb"}}
             */
            execQuery(query, function (err, res) {
                if (!error(query, args, err, cb)) {
                    res.rows.forEach(function (row) {
                        var attrs = transformDBRowToJSObject(row)
                        var ent = relationalstore.makeent(qent, attrs)
                        list.push(ent)
                    })
                    seneca.log(args.tag$, 'list', list.length, list[0])
                    cb(null, list)
                }
                else {
                    seneca.fail({code: 'list', tag: args.tag$, store: store.name, query: query, error: err}, cb)
                }
            })
        },


        remove: function (args, cb) {
            var qent = args.qent
            var q = args.q

            if (q.id) {
                console.log(qent)
                var query = deletestm(qent, q)
                _db.delete().from(query.table).where({'@rid': q.id}).limit(1).scalar()
                    .then(function (total) {
                        seneca.log(args.tag$, 'remove', total)
                        cb(null, {'deleted': total})
                    });
            }
            else if (q.all$) {
                var query = deletestm(qent, q)

                execQuery(query, function (err, res) {
                    if (!error(query, args, err, cb)) {
                        seneca.log(args.tag$, 'remove', res.rowCount)
                        cb(null, res.rowCount)
                    } else if (err) {
                        cb(err, undefined)
                    } else {
                        err = new Error('no candidate for deletion')
                        err.critical = false
                        cb(err, undefined)
                    }
                })
            }
            else {
                var selectQuery = selectstm(qent, q)

                execQuery(selectQuery, function (err, res) {
                    if (!error(selectQuery, args, err, cb)) {

                        var entp = res.rows[0]

                        if (!entp) {
                            err = new Error('no candidate for deletion')
                            err.critical = false
                            cb(err, undefined)
                        } else {

                            var query = deletestm(qent, {id: entp.id})

                            execQuery(query, function (err, res) {
                                if (!err) {
                                    seneca.log(args.tag$, 'remove', res.rowCount)
                                    cb(null, res.rowCount)
                                }
                                else {
                                    cb(err, undefined)
                                }
                            })
                        }
                    } else {

                        var errorDetails = {
                            message: err.message,
                            err: err,
                            stack: err.stack,
                            query: query
                        }
                        seneca.log.error('Query Failed', JSON.stringify(errorDetails, null, 1))
                        callback(err, undefined)
                    }
                })
            }
        },


        native: function (args, done) {
//      dbinst.collection('seneca', function(err,coll){
//        if( !error(args,err,cb) ) {
//          coll.findOne({},{},function(err,entp){
//            if( !error(args,err,cb) ) {
//              done(null,dbinst)
//            }else{
//              done(err)
//            }
//          })
//        }else{
//          done(err)
//        }
//      })
        }

    }


    var savestm = function (ent) {
        var stm = {}

        var table = relationalstore.tablename(ent)
        var entp = relationalstore.makeentp(ent)

        stm.table = table
        stm.entp = entp
        delete entp.id

        return stm
    }


    var updatestm = function (ent) {
        var stm = {}

        stm.table = relationalstore.tablename(ent)
        stm.entp = relationalstore.makeentp(ent)
        stm.rid = stm.entp.id
        delete stm.entp.id


        return stm
    }


    var deletestm = function (qent, q) {
        var stm = {}

        stm.table = relationalstore.tablename(qent)
        var entp = relationalstore.makeentp(qent)

        stm.rid = entp.id

        return stm
    }


    var distinctStatement = function (qent, q) {
        var stm = {}

        var table = relationalstore.tablename(qent)
        var entp = relationalstore.makeentp(qent)

        var values = []
        var params = []

        var cnt = 0

        var w = whereargs(entp, q)

        var wherestr = ''

        if (!_.isEmpty(w) && w.params.length > 0) {
            w.params.forEach(function (param) {
                params.push('"' + escapeStr(camelToSnakeCase(param)) + '"=$' + (++cnt))
            })

            w.values.forEach(function (value) {
                values.push(value)
            })

            wherestr = " WHERE " + params.join(' AND ')
        }

        var mq = metaquery(qent, q)

        var metastr = ' ' + mq.params.join(' ')

        var distinctParams = q.distinct$

        var selectColumns = []
        if (distinctParams && !_.isString(distinctParams) && _.isArray(distinctParams)) {
            selectColumns = distinctParams
        }
        if (selectColumns.length === 0) {
            selectColumns.push('*')
        }

        stm.text = "SELECT DISTINCT " + escapeStr(selectColumns.join(',')) + " FROM " + escapeStr(table) + wherestr + escapeStr(metastr)
        stm.values = values

        return stm
    }

    var selectstm = function (qent, q) {
        var stm = {}

        var table = relationalstore.tablename(qent)
        var entp = relationalstore.makeentp(qent)

        var values = {}
        var params = []

        var w = whereargs(entp, q)

        var wherestr = ''

        if (!_.isEmpty(w) && w.params.length > 0) {
            w.params.forEach(function (param, i) {
                var toSnakeCase = camelToSnakeCase(param);
                if (w.values[i] === null) {
                    // we can't use the equality on null because NULL != NULL
                    w.values.splice(i, 1)
                    params.push(escapeStr(toSnakeCase) + ' IS NULL')
                } else if (w.values[i] instanceof RegExp) {
                    var op = (w.values[i].ignoreCase) ? '~*' : '~';
                    params.push(escapeStr(toSnakeCase) + op + ':' + toSnakeCase)
                    values[toSnakeCase] = w.values[i];
                } else {
                    var op = '=';
                    if (toSnakeCase == 'id') {
                        params.push('@rid' + op + ':rid')
                        values['rid'] = w.values[i];
                    } else {
                        params.push(escapeStr(toSnakeCase) + op + ':' + toSnakeCase)
                        values[toSnakeCase] = w.values[i];
                    }
                }
            })

            //w.values.forEach(function (value) {
            //    values.push(value)
            //})

            wherestr = " WHERE " + params.join(' AND ')
        }

        var mq = metaquery(qent, q)

        var metastr = ' ' + mq.params.join(' ')

        stm.text = "SELECT * FROM " + escapeStr(table) + wherestr + escapeStr(metastr)
        stm.values = values

        return stm
    }

    var selectstmOr = function (qent, q) {
        var stm = {}

        var table = relationalstore.tablename(qent)
        var entp = relationalstore.makeentp(qent)

        var values = []
        var params = []

        var cnt = 0

        var w = whereargs(entp, q.ids)

        var wherestr = ''

        if (!_.isEmpty(w) && w.params.length > 0) {
            w.params.forEach(function (param) {
                params.push('"' + escapeStr(camelToSnakeCase('id')) + '"=$' + (++cnt))
            })

            w.values.forEach(function (value) {
                values.push(value)
            })

            wherestr = " WHERE " + params.join(' OR ')
        }

        //This is required to set the limit$ to be the length of the 'ids' array, so that in situations
        //when it's not set in the query(q) it won't be applied the default limit$ of 20 records
        if (!q.limit$) {
            q.limit$ = q.ids.length
        }

        var mq = metaquery(qent, q)

        var metastr = ' ' + mq.params.join(' ')

        stm.text = "SELECT * FROM " + escapeStr(table) + wherestr + escapeStr(metastr)
        stm.values = values

        return stm
    }

    var whereargs = function (entp, q) {
        var w = {}

        w.params = []
        w.values = []

        var qok = relationalstore.fixquery(entp, q)

        for (var p in qok) {
            if (qok[p] !== undefined) {
                w.params.push(camelToSnakeCase(p))
                w.values.push(qok[p])
            }
        }

        return w
    }


    var metaquery = function (qent, q) {
        var mq = {}

        mq.params = []
        mq.values = []

        if (q.sort$) {
            for (var sf in q.sort$) break;
            var sd = q.sort$[sf] < 0 ? 'ASC' : 'DESC'
            mq.params.push('ORDER BY ' + camelToSnakeCase(sf) + ' ' + sd)
        }

        if (q.limit$) {
            mq.params.push('LIMIT ' + q.limit$)
        } else {
            mq.params.push('LIMIT 20')
        }

        if (q.skip$) {
            mq.params.push('OFFSET ' + q.skip$)
        }

        return mq
    }

    var meta = seneca.store.init(seneca, opts, store);

    seneca.add({init: store.name, tag: meta.tag}, function (args, cb) {

        configure(opts, function (err) {
            cb(err)
        })
    })

    return {name: store.name, tag: meta.tag};

}


var escapeStr = function (input) {
    if (input instanceof Date) {
        return input
    }
    var str = "" + input;
    return str.replace(/[\0\b\t\x08\x09\x1a\n\r"'\\\%]/g, function (char) {
        switch (char) {
            case "\0":
                return "\\0";
            case "\x08":
                return "\\b";
            case "\b":
                return "\\b";
            case "\x09":
                return "\\t";
            case "\t":
                return "\\t";
            case "\x1a":
                return "\\z";
            case "\n":
                return "\\n";
            case "\r":
                return "\\r";
            case "\"":
            case "'":
            case "\\":
            case "%":
                return "\\" + char;

        }
    });
};
