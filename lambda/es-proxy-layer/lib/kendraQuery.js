/**
 * optional environment variables - These are not used defined during setup of this function in QnABot but are
 * useful for testing if defined.
 *
 * REGION - optional AWS region to target
 *
 */

var _ = require('lodash');
const AWS = require('aws-sdk');
const qnabot = require("qnabot/logging")
const open_es = require("./es_query")


function allow_kendra_result(kendra_result, minimum_score){
    if (!confidence_filter(minimum_score,kendra_result)) {
        qnabot.log(`Result removed: ScoreConfidence [${_.get(kendra_result,"ScoreAttributes.ScoreConfidence")}] below threshold [${minimum_score}] - Passage: ${_.get(kendra_result,"DocumentExcerpt.Text")}`);
        return false;
    }
    qnabot.log(`Result allowed: Type [${kendra_result.Type}], ScoreConfidence [${_.get(kendra_result,"ScoreAttributes.ScoreConfidence")}] - Passage: ${_.get(kendra_result,"DocumentExcerpt.Text")}`);
    return true;
}

function confidence_filter(minimum_score,kendra_result){
    var confidences = ["LOW","MEDIUM","HIGH","VERY_HIGH"]
    var index = confidences.findIndex( i => i == minimum_score.toUpperCase())
    if(index == undefined){
        qnabot.log("Warning: ALT_SEARCH_KENDRA_FALLBACK_CONFIDENCE_SCORE should be one of 'VERY_HIGH'|'HIGH'|'MEDIUM'|'LOW'")
        return true;
    }
    confidences = confidences.slice(index)
    const found = confidences.find(element => element == _.get(kendra_result,"ScoreAttributes.ScoreConfidence")) != undefined
    return found
}



/**
 * Function to query kendraClient and return results via Promise
 * @param kendraClient
 * @param params
 * @param resArray
 * @returns {*}
 */
function kendraRequester(kendraClient,params,resArray) {
    return new Promise(function(resolve, reject) {
        kendraClient.query(params, function(err, data) {
            let indexId = params.IndexId;
            if (err) {
                qnabot.log(err, err.stack);
                reject('Error from Kendra query request:' + err);
            }
            else {
                data.originalKendraIndexId = indexId;
                qnabot.log("Kendra response:" + JSON.stringify(data, null, 2));
                resArray.push(data);
                resolve(data);
            }
        });
    });
}





async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}


/** Function that processes kendra requests and handles response. Decides whether to handle SNS
 * events or Lambda Hook events from QnABot.
 * @param request - request parameters object
//  * @param event - input event passed to the Lambda Handler
//  * @param context - input context passed to the Lambda Handler
 * @returns {Promise<*>} - returns the response in event.res
 */
async function routeKendraRequest(request_params) {
    
    AWS.config.update({
      maxRetries: request_params.maxRetries,
      retryDelayOptions: {
        base: request_params.retryDelay
      },
    });
    
    var kendraClient = (process.env.REGION ?
            new AWS.Kendra({apiVersion: '2019-02-03', region: process.env.REGION}) :
            new AWS.Kendra({apiVersion: '2019-02-03'})
        );
        
    
    let promises = [];
    let resArray = [];
    let kendraIndexes = undefined;
    let kendraFaqIndex = request_params.kendra_faq_index;
    if (kendraFaqIndex != "" && kendraFaqIndex != undefined) {
        kendraIndexes = [kendraFaqIndex];
    } else {
        throw new Error("Undefined KendraFAQIndex: " + kendraFaqIndex);
    }
    // Iterate through this area and perform queries against Kendra.
    kendraIndexes.forEach(function (index, i) {
        const params = {
            IndexId: index, /* required */
            QueryText: request_params.question
        };
        let p = kendraRequester(kendraClient,params,resArray);
        promises.push(p);
    });
    await Promise.all(promises);


    // ----- process kendra query responses and update answer content -----

    /* default message text - can be overridden using QnABot SSM Parameter Store Custom Property */
    let foundAnswerCount = 0;
    let kendraQueryId;
    let kendraIndexId;
    let kendraResultId;
    let json_struct = [];
    
    
    // note that this outside for loop will only execute once (one FAQ index) but the structure was kept due to its elegance
    //resArray.forEach(async function (res) {
    await asyncForEach(resArray, async function (res) {
        if (res && res.ResultItems && res.ResultItems.length > 0) {
            
            var i, element;
            for (i=0; i<res.ResultItems.length; i++) {
                element = res.ResultItems[i];

                if(!allow_kendra_result(element, request_params.minimum_score))
                    continue;

                /* Note - only FAQ format will be provided back to the requester */
                if (element.Type === 'QUESTION_ANSWER' && foundAnswerCount < request_params.size && element.AdditionalAttributes &&
                    element.AdditionalAttributes.length > 1) {

                    if (!open_es.hasJsonStructure(element.DocumentURI)) {
                        break;
                    }
                    var hit = JSON.parse(element.DocumentURI);
                    if (_.get(hit,"_source_qid")) {
                        let qid = hit._source_qid ;
                        // FAQ only references the QID but doesn't contain the full docunment.. retrieve it from ES
                        qnabot.log("Kendra matched qid: ", qid, ". Retrieving full document from Elasticsearch.");
                        let es_response = await open_es.run_qid_query_es(request_params, qid) ;
                        qnabot.log("Qid document from Kendra: ", JSON.stringify(hit));
                        hit = _.get(es_response, "hits.hits[0]._source"); //todo fix if null -- test from content designer
                        if(hit == null){
                            qnabot.log("WARNING: An answer was found in Kendrs FAQ, but a corresponding answer was not found in ElasticSearch for "+ hit)
                            continue;

                        }
                        if(_.get(hit,"QNAClientFilter")){
                            qnabot.log("Found an answer with a clientFilterValue set...skipping")
                            continue;
                        }
                    }
                    
                    qnabot.log(`hit is ${JSON.stringify(hit)}`);
                    json_struct.push(hit);

                    kendraQueryId = res.QueryId; // store off the QueryId to use as a session attribute for feedback
                    kendraIndexId = res.originalKendraIndexId; // store off the Kendra IndexId to use as a session attribute for feedback
                    kendraResultId = element.Id; // store off resultId to use as a session attribute for feedback
                    foundAnswerCount++;
                }
            }
        }
    });
    
    // return query response structure to make Kendra results look like ES results so we don't have to change the UI
    var hits_struct = {
        // "took": 104,
        "timed_out": false,
        "hits": {
            "total": {
                "value": foundAnswerCount,  // if no answers found, total hits # is 0 and hits list is empty
                "relation": "eq"
            },
            "max_score": json_struct.length,
            "hits": [],
        },
    }
    if (kendraQueryId) {
        hits_struct.kendra_context = {
            "kendraQueryId":kendraQueryId,
            "kendraIndexId":kendraIndexId,
            "kendraResultId":kendraResultId,
            "kendraResponsibleQid":"KendraFAQ"
        }
    }

    
    let ans = {};
    var j, faq_struct;
    var num=json_struct.length;
    if (request_params.size) {
        num = Math.min(num, request_params.size);
    }
    for (j=0; j<num; j++) {
        faq_struct = json_struct[j];
        
        ans = {
            "_index": request_params.kendra_faq_index,
            "_type": "_faq",
            "_id": faq_struct.qid,
            "_score": json_struct.length-j, // score is inverse ranking of returned results
            "_source": faq_struct
        }
        hits_struct.hits.hits.push(ans);
    }
    
    // cache kendra results to optimize fallback engine
    if (request_params.same_index && resArray.length>0) {
        hits_struct['kendraResultsCached'] = resArray[0];
    }
    
    qnabot.debug("RETURN: " + JSON.stringify(hits_struct));
    return hits_struct;
}

exports.handler = async (request_params) => {
    qnabot.log("Kendra request params: " + JSON.stringify(request_params));
    return routeKendraRequest(request_params);
};
